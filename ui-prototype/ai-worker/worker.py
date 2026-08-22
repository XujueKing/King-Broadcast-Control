"""KING CLUB offline audio-analysis worker bootstrap.

This process is intentionally separate from Tauri/mpv. It leases one persistent
job at a time so model inference cannot interrupt the live playback process.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


WORKER_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WORKER_ROOT.parent
PIPELINE_PATH = WORKER_ROOT / "pipeline.json"
REQUIRED_MODULES = {
    "torch": "PyTorch CPU runtime",
    "demucs": "Demucs source separation",
    "qwen_asr": "Qwen3-ASR and ForcedAligner",
    "faster_whisper": "fallback ASR",
    "modelscope": "Mainland China model download",
}


def load_pipeline() -> dict[str, Any]:
    return json.loads(PIPELINE_PATH.read_text(encoding="utf-8"))


def resolve_model_source(configuration: dict[str, Any]) -> str:
    local_directory = configuration.get("localDirectory")
    if local_directory:
        local_path = PROJECT_ROOT / str(local_directory)
        if local_path.is_dir():
            return str(local_path)
    return str(configuration["model"])


def default_database_path() -> Path:
    app_data = os.environ.get("APPDATA")
    if not app_data:
        raise RuntimeError("APPDATA is unavailable")
    return Path(app_data) / "club.king.broadcast-control" / "king-club.sqlite3"


def module_status() -> dict[str, bool]:
    return {name: importlib.util.find_spec(name) is not None for name in REQUIRED_MODULES}


def queue_summary(database_path: Path) -> dict[str, int]:
    if not database_path.is_file():
        return {}
    with sqlite3.connect(database_path) as connection:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_analysis_jobs'"
        ).fetchone()
        if table is None:
            return {}
        return {
            str(status): int(count)
            for status, count in connection.execute(
                "SELECT status, COUNT(*) FROM ai_analysis_jobs GROUP BY status"
            )
        }


def ensure_job_table(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path, timeout=5) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               media_path TEXT NOT NULL,
               media_fingerprint TEXT NOT NULL,
               pipeline_version TEXT NOT NULL,
               status TEXT NOT NULL,
               stage TEXT NOT NULL,
               derived_directory TEXT NOT NULL,
               separator_model TEXT NOT NULL,
               asr_model TEXT NOT NULL,
               aligner_model TEXT NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,
               error_message TEXT,
               created_at_unix_ms INTEGER NOT NULL,
               updated_at_unix_ms INTEGER NOT NULL,
               UNIQUE(media_fingerprint, pipeline_version)
             )"""
        )


def update_job(
    database_path: Path,
    job_id: int,
    *,
    status: str,
    stage: str,
    error_message: str | None = None,
) -> None:
    now = int(time.time() * 1000)
    with sqlite3.connect(database_path, timeout=5) as connection:
        connection.execute(
            """UPDATE ai_analysis_jobs
               SET status=?, stage=?, error_message=?, updated_at_unix_ms=?
               WHERE id=?""",
            (status, stage, error_message, now, job_id),
        )


def recover_running_jobs(database_path: Path) -> int:
    if not database_path.is_file():
        return 0
    now = int(time.time() * 1000)
    with sqlite3.connect(database_path, timeout=5) as connection:
        cursor = connection.execute(
            """UPDATE ai_analysis_jobs
               SET status='failed', stage='interrupted',
                   error_message='worker interrupted before completion', updated_at_unix_ms=?
               WHERE status='running'""",
            (now,),
        )
        return int(cursor.rowcount)


def lease_job(
    database_path: Path,
    job_id: int | None,
    *,
    include_failed: bool = True,
) -> dict[str, Any] | None:
    with sqlite3.connect(database_path, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN IMMEDIATE")
        if job_id is None:
            statuses = "('queued', 'failed')" if include_failed else "('queued')"
            row = connection.execute(
                f"""SELECT * FROM ai_analysis_jobs
                    WHERE status IN {statuses}
                    ORDER BY created_at_unix_ms, id LIMIT 1"""
            ).fetchone()
        else:
            row = connection.execute(
                "SELECT * FROM ai_analysis_jobs WHERE id=? AND status IN ('queued', 'failed')",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        now = int(time.time() * 1000)
        connection.execute(
            """UPDATE ai_analysis_jobs
               SET status='running', stage='separating', attempts=attempts+1,
                   error_message=NULL, updated_at_unix_ms=? WHERE id=?""",
            (now, row["id"]),
        )
        result = dict(row)
        result["status"] = "running"
        result["stage"] = "separating"
        result["attempts"] += 1
        return result


def list_jobs(database_path: Path) -> list[dict[str, Any]]:
    if not database_path.is_file():
        return []
    with sqlite3.connect(database_path, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in connection.execute(
                """SELECT id, media_path, status, stage, attempts, error_message,
                          derived_directory, updated_at_unix_ms
                   FROM ai_analysis_jobs ORDER BY id"""
            )
        ]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def convert_to_flac(source: Path, destination: Path) -> None:
    import soundfile as sf

    destination.parent.mkdir(parents=True, exist_ok=True)
    with sf.SoundFile(source, "r") as input_file:
        with sf.SoundFile(
            destination,
            "w",
            samplerate=input_file.samplerate,
            channels=input_file.channels,
            format="FLAC",
            subtype="PCM_16",
        ) as output_file:
            while True:
                block = input_file.read(262_144, dtype="float32", always_2d=True)
                if len(block) == 0:
                    break
                output_file.write(block)


def separate_stems(media_path: Path, working_directory: Path, model: str) -> tuple[Path, Path]:
    demucs_output = working_directory / "demucs"
    command = [
        sys.executable,
        "-m",
        "demucs",
        "--name",
        model,
        "--two-stems",
        "vocals",
        "--jobs",
        "1",
        "--out",
        str(demucs_output),
        str(media_path),
    ]
    subprocess.run(command, check=True)
    vocals_wav = next(iter(demucs_output.rglob("vocals.wav")), None)
    accompaniment_wav = next(iter(demucs_output.rglob("no_vocals.wav")), None)
    if vocals_wav is None or accompaniment_wav is None:
        raise RuntimeError("Demucs completed without vocals.wav/no_vocals.wav")
    vocals_flac = working_directory / "vocals.flac"
    accompaniment_flac = working_directory / "no_vocals.flac"
    convert_to_flac(vocals_wav, vocals_flac)
    convert_to_flac(accompaniment_wav, accompaniment_flac)
    shutil.rmtree(demucs_output, ignore_errors=True)
    return vocals_flac, accompaniment_flac


def transcribe_vocals(vocals_path: Path, model_name: str) -> tuple[str, str | None]:
    import torch
    from qwen_asr import Qwen3ASRModel

    model = Qwen3ASRModel.from_pretrained(
        model_name,
        dtype=torch.float32,
        device_map="cpu",
        low_cpu_mem_usage=True,
        max_inference_batch_size=1,
        max_new_tokens=2048,
    )
    try:
        result = model.transcribe(audio=str(vocals_path), language=None)[0]
        return result.text.strip(), result.language
    finally:
        del model
        gc.collect()


def align_lyrics(
    vocals_path: Path,
    text: str,
    language: str | None,
    model_name: str,
) -> list[dict[str, Any]]:
    import torch
    from qwen_asr import Qwen3ForcedAligner

    normalized_language = language or "Chinese"
    model = Qwen3ForcedAligner.from_pretrained(
        model_name,
        dtype=torch.float32,
        device_map="cpu",
    )
    try:
        result = model.align(
            audio=str(vocals_path),
            text=text,
            language=normalized_language,
        )[0]
        return [
            {
                "text": str(item.text),
                "startSeconds": float(item.start_time),
                "endSeconds": float(item.end_time),
            }
            for item in result.items
        ]
    finally:
        del model
        gc.collect()


def lrc_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    minutes, remainder = divmod(centiseconds, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"[{minutes:02d}:{whole_seconds:02d}.{fraction:02d}]"


def build_lrc(items: list[dict[str, Any]]) -> str:
    lines: list[tuple[float, str]] = []
    current: list[str] = []
    line_start = 0.0
    previous_end = 0.0
    for item in items:
        token = item["text"]
        start = float(item["startSeconds"])
        should_break = bool(current) and (start - previous_end > 1.15 or len("".join(current)) >= 16)
        if should_break:
            lines.append((line_start, "".join(current).strip()))
            current = []
        if not current:
            line_start = start
        current.append(token)
        previous_end = float(item["endSeconds"])
    if current:
        lines.append((line_start, "".join(current).strip()))
    return "\n".join(f"{lrc_timestamp(start)}{text}" for start, text in lines if text) + "\n"


def publish_artifacts(working_directory: Path, derived_directory: Path) -> None:
    for name in ("lyrics.txt", "lyrics.lrc", "lyrics.words.json"):
        source = working_directory / name
        if not source.is_file():
            raise RuntimeError(f"missing required artifact: {name}")
        os.replace(source, derived_directory / name)


def process_job(database_path: Path, job: dict[str, Any], pipeline: dict[str, Any]) -> None:
    job_id = int(job["id"])
    media_path = Path(job["media_path"])
    derived_directory = Path(job["derived_directory"])
    working_directory = derived_directory / ".working"
    shutil.rmtree(working_directory, ignore_errors=True)
    working_directory.mkdir(parents=True, exist_ok=True)
    started_at = time.monotonic()
    try:
        vocals_path = derived_directory / "vocals.flac"
        accompaniment_path = derived_directory / "no_vocals.flac"
        if not vocals_path.is_file() or not accompaniment_path.is_file():
            separated_vocals, separated_accompaniment = separate_stems(
                media_path, working_directory, pipeline["separator"]["model"]
            )
            os.replace(separated_vocals, vocals_path)
            os.replace(separated_accompaniment, accompaniment_path)
        update_job(database_path, job_id, status="running", stage="transcribing")
        text, language = transcribe_vocals(
            vocals_path, resolve_model_source(pipeline["asr"])
        )
        if not text:
            raise RuntimeError("Qwen3-ASR returned empty lyrics")
        (working_directory / "lyrics.txt").write_text(text + "\n", encoding="utf-8")
        update_job(database_path, job_id, status="running", stage="aligning")
        words = align_lyrics(
            vocals_path,
            text,
            language,
            resolve_model_source(pipeline["aligner"]),
        )
        if not words:
            raise RuntimeError("ForcedAligner returned no timestamp items")
        (working_directory / "lyrics.words.json").write_text(
            json.dumps({"language": language, "items": words}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (working_directory / "lyrics.lrc").write_text(build_lrc(words), encoding="utf-8")
        update_job(database_path, job_id, status="running", stage="publishing")
        publish_artifacts(working_directory, derived_directory)
        manifest = {
            "mediaPath": str(media_path),
            "mediaFingerprint": job["media_fingerprint"],
            "sourceSha256": sha256_file(media_path),
            "pipelineVersion": pipeline["pipelineVersion"],
            "separatorModel": pipeline["separator"]["model"],
            "asrModel": pipeline["asr"]["model"],
            "alignerModel": pipeline["aligner"]["model"],
            "language": language,
            "status": "ready",
            "elapsedSeconds": round(time.monotonic() - started_at, 3),
        }
        temporary_manifest = derived_directory / "manifest.json.tmp"
        temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary_manifest, derived_directory / "manifest.json")
        update_job(database_path, job_id, status="ready", stage="complete")
    except Exception as error:
        update_job(database_path, job_id, status="failed", stage="failed", error_message=str(error))
        raise
    finally:
        shutil.rmtree(working_directory, ignore_errors=True)


def preflight(database_path: Path) -> dict[str, Any]:
    pipeline = load_pipeline()
    modules = module_status()
    model_sources = {
        "asr": resolve_model_source(pipeline["asr"]),
        "aligner": resolve_model_source(pipeline["aligner"]),
    }
    local_models_ready = all(Path(source).is_dir() for source in model_sources.values())
    return {
        "ok": (
            sys.version_info[:2] == (3, 12)
            and all(modules.values())
            and local_models_ready
        ),
        "python": platform.python_version(),
        "pythonSupported": sys.version_info[:2] == (3, 12),
        "pipelineVersion": pipeline["pipelineVersion"],
        "asrModel": pipeline["asr"]["model"],
        "alignerModel": pipeline["aligner"]["model"],
        "separatorModel": pipeline["separator"]["model"],
        "concurrency": pipeline["concurrency"],
        "modules": modules,
        "modelSources": model_sources,
        "localModelsReady": local_models_ready,
        "database": str(database_path),
        "queue": queue_summary(database_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="KING CLUB audio AI worker")
    parser.add_argument("--preflight", action="store_true", help="print environment readiness")
    parser.add_argument("--list", action="store_true", help="print persistent analysis jobs")
    parser.add_argument("--once", action="store_true", help="process one queued job and exit")
    parser.add_argument("--run", action="store_true", help="continuously process queued jobs")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    parser.add_argument("--job-id", type=int, help="process a specific queued/failed job")
    parser.add_argument("--recover-running", action="store_true", help="mark abandoned running jobs retryable")
    parser.add_argument("--database", type=Path, default=default_database_path())
    args = parser.parse_args()
    if args.preflight:
        report = preflight(args.database)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 2
    if args.list:
        print(json.dumps(list_jobs(args.database), ensure_ascii=False, indent=2))
        return 0
    if args.recover_running:
        print(json.dumps({"recovered": recover_running_jobs(args.database)}, indent=2))
        return 0
    if args.once:
        report = preflight(args.database)
        if not report["ok"]:
            print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
            return 2
        job = lease_job(args.database, args.job_id)
        if job is None:
            print("No queued AI analysis job.")
            return 0
        print(f"Processing AI job {job['id']}: {job['media_path']}", flush=True)
        try:
            process_job(args.database, job, load_pipeline())
        except KeyboardInterrupt:
            update_job(
                args.database,
                int(job["id"]),
                status="failed",
                stage="interrupted",
                error_message="worker interrupted by operator",
            )
            return 130
        print(f"AI job {job['id']} completed.", flush=True)
        return 0
    if args.run:
        report = preflight(args.database)
        if not report["ok"]:
            print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
            return 2
        ensure_job_table(args.database)
        recover_running_jobs(args.database)
        print("KING CLUB AI worker ready.", flush=True)
        while True:
            job = lease_job(args.database, None, include_failed=False)
            if job is None:
                try:
                    time.sleep(max(0.5, args.poll_seconds))
                except KeyboardInterrupt:
                    return 130
                continue
            print(f"Processing AI job {job['id']}: {job['media_path']}", flush=True)
            try:
                process_job(args.database, job, load_pipeline())
                print(f"AI job {job['id']} completed.", flush=True)
            except KeyboardInterrupt:
                update_job(
                    args.database,
                    int(job["id"]),
                    status="failed",
                    stage="interrupted",
                    error_message="worker interrupted by operator",
                )
                return 130
            except Exception as error:
                print(f"AI job {job['id']} failed: {error}", file=sys.stderr, flush=True)
    parser.error("choose --preflight, --once or --run")


if __name__ == "__main__":
    raise SystemExit(main())
