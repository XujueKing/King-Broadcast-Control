"""KING CLUB offline audio-analysis worker bootstrap.

This process is intentionally separate from Tauri/mpv. It leases one persistent
job at a time so model inference cannot interrupt the live playback process.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


WORKER_ROOT = Path(__file__).resolve().parent
PIPELINE_PATH = WORKER_ROOT / "pipeline.json"
REQUIRED_MODULES = {
    "torch": "PyTorch CUDA runtime",
    "audio_separator": "BS-RoFormer source separation",
    "demucs": "Demucs source separation",
    "requests": "MOSS-Music service client",
}

REFERENCE_SAMPLE_RATE = 48_000
REFERENCE_HOP_FRAMES = 128
REFERENCE_GENERATOR_VERSION = "king-reference-pyin-v1"


def load_pipeline() -> dict[str, Any]:
    return json.loads(PIPELINE_PATH.read_text(encoding="utf-8"))


def default_database_path() -> Path:
    app_data = os.environ.get("APPDATA")
    if not app_data:
        raise RuntimeError("APPDATA is unavailable")
    return Path(app_data) / "club.king.broadcast-control" / "king-club.sqlite3"


def module_status() -> dict[str, bool]:
    return {name: importlib.util.find_spec(name) is not None for name in REQUIRED_MODULES}


def compute_status() -> dict[str, Any]:
    pipeline = load_pipeline()
    configuration = pipeline.get("compute", {})
    requested_device = str(configuration.get("device", "cuda:0"))
    requested_dtype = str(configuration.get("dtype", "bfloat16"))
    require_cuda = bool(configuration.get("requireCuda", True))
    try:
        import torch

        cuda_available = torch.cuda.is_available()
        return {
            "requestedDevice": requested_device,
            "requestedDtype": requested_dtype,
            "requireCuda": require_cuda,
            "torch": torch.__version__,
            "cudaBuild": torch.version.cuda,
            "cudaAvailable": cuda_available,
            "deviceName": torch.cuda.get_device_name(0) if cuda_available else None,
            "computeCapability": list(torch.cuda.get_device_capability(0)) if cuda_available else None,
            "bf16Supported": torch.cuda.is_bf16_supported() if cuda_available else False,
        }
    except Exception as error:
        return {
            "requestedDevice": requested_device,
            "requestedDtype": requested_dtype,
            "requireCuda": require_cuda,
            "torch": None,
            "cudaBuild": None,
            "cudaAvailable": False,
            "deviceName": None,
            "computeCapability": None,
            "bf16Supported": False,
            "error": str(error),
        }


def torch_inference_runtime():
    import torch

    status = compute_status()
    if status["requireCuda"] and not status["cudaAvailable"]:
        raise RuntimeError("CUDA is required by pipeline.json but PyTorch cannot access the GPU")
    device = status["requestedDevice"] if status["cudaAvailable"] else "cpu"
    if device.startswith("cuda") and status["requestedDtype"] == "bfloat16":
        if not status["bf16Supported"]:
            raise RuntimeError("pipeline requests bfloat16 but the CUDA device does not support it")
        dtype = torch.bfloat16
    elif device.startswith("cuda"):
        dtype = torch.float16
    else:
        dtype = torch.float32
    return torch, device, dtype


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
    connection = sqlite3.connect(database_path, timeout=5)
    try:
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
               priority INTEGER NOT NULL DEFAULT 2,
               UNIQUE(media_fingerprint, pipeline_version)
             )"""
        )
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(ai_analysis_jobs)")
        }
        if "priority" not in columns:
            connection.execute(
                "ALTER TABLE ai_analysis_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 2"
            )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_scheduler
               ON ai_analysis_jobs(status, priority, created_at_unix_ms, id)"""
        )
        connection.commit()
    finally:
        connection.close()


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
               SET status='queued', stage='retrying',
                   error_message='worker interrupted; automatic retry pending', updated_at_unix_ms=?
               WHERE status='running'
                  OR (status='failed' AND stage='interrupted')
                  OR (status='failed' AND attempts < 3 AND (
                        error_message LIKE 'Expecting % delimiter:%'
                     OR error_message LIKE 'Unterminated string:%'
                     OR error_message LIKE 'Extra data:%'
                  ))""",
            (now,),
        )
        return int(cursor.rowcount)


def lease_job(
    database_path: Path,
    job_id: int | None,
    *,
    include_failed: bool = True,
) -> dict[str, Any] | None:
    connection = sqlite3.connect(database_path, timeout=5)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN IMMEDIATE")
        if job_id is None:
            statuses = "('queued', 'failed')" if include_failed else "('queued')"
            row = connection.execute(
                f"""SELECT * FROM ai_analysis_jobs
                    WHERE status IN {statuses}
                    ORDER BY priority, created_at_unix_ms, id LIMIT 1"""
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
        connection.commit()
        return result
    finally:
        connection.close()


def list_jobs(database_path: Path) -> list[dict[str, Any]]:
    if not database_path.is_file():
        return []
    with sqlite3.connect(database_path, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in connection.execute(
                """SELECT id, media_path, status, stage, priority, attempts, error_message,
                          derived_directory, updated_at_unix_ms
                   FROM ai_analysis_jobs ORDER BY priority, id"""
            )
        ]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_reference_map(
    f0_values,
    voiced_probabilities,
    *,
    source_fingerprint: str,
    source_duration_samples: int,
    separator_profile_value: dict[str, Any],
) -> dict[str, Any]:
    """Compress offline F0 observations into the realtime engine's read-only map."""
    if len(f0_values) != len(voiced_probabilities):
        raise RuntimeError("reference F0 and confidence lengths differ")
    segments: list[dict[str, Any]] = []
    current_note: int | None = None
    maximum_gap = REFERENCE_HOP_FRAMES * 2
    for index, (f0_value, probability_value) in enumerate(zip(f0_values, voiced_probabilities)):
        f0 = float(f0_value)
        probability = float(probability_value)
        if not math.isfinite(f0) or f0 <= 0 or not math.isfinite(probability) or probability < 0.72:
            current_note = None
            continue
        measured_midi = 69.0 + 12.0 * math.log2(f0 / 440.0)
        nearest = max(0, min(127, math.floor(measured_midi + 0.5)))
        selected = (
            current_note
            if current_note is not None and abs(measured_midi - current_note) <= 0.62
            else nearest
        )
        start_sample = index * REFERENCE_HOP_FRAMES
        end_sample = min(start_sample + REFERENCE_HOP_FRAMES, source_duration_samples)
        if end_sample <= start_sample:
            break
        if (
            segments
            and segments[-1]["midiNote"] == selected
            and start_sample <= segments[-1]["endSample"] + maximum_gap
        ):
            segments[-1]["endSample"] = end_sample
            segments[-1]["confidence"] = round(
                (segments[-1]["confidence"] + probability) * 0.5, 6
            )
        else:
            segments.append(
                {
                    "startSample": start_sample,
                    "endSample": end_sample,
                    "midiNote": selected,
                    "targetHz": round(440.0 * (2.0 ** ((selected - 69) / 12.0)), 6),
                    "confidence": round(probability, 6),
                }
            )
        current_note = selected
    if not segments:
        raise RuntimeError("reference analysis found no confident vocal pitch")
    return {
        "schemaVersion": 1,
        "sampleRate": REFERENCE_SAMPLE_RATE,
        "hopFrames": REFERENCE_HOP_FRAMES,
        "source": "vocals.flac",
        "sourceFingerprint": source_fingerprint,
        "sourceDurationSamples": source_duration_samples,
        "timelineOffsetSamples": 0,
        "generatorVersion": REFERENCE_GENERATOR_VERSION,
        "separatorProfile": separator_profile_value,
        "segments": segments,
    }


def reference_map_is_current(
    path: Path, source_fingerprint: str, separator_profile_value: dict[str, Any]
) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        segments = payload.get("segments")
        return (
            payload.get("schemaVersion") == 1
            and payload.get("sampleRate") == REFERENCE_SAMPLE_RATE
            and payload.get("hopFrames") == REFERENCE_HOP_FRAMES
            and payload.get("sourceFingerprint") == source_fingerprint
            and payload.get("generatorVersion") == REFERENCE_GENERATOR_VERSION
            and payload.get("separatorProfile") == separator_profile_value
            and isinstance(segments, list)
            and len(segments) > 0
        )
    except (OSError, ValueError, TypeError):
        return False


def generate_reference_map(
    vocals_path: Path,
    destination: Path,
    source_fingerprint: str,
    separator_profile_value: dict[str, Any],
) -> dict[str, Any]:
    import librosa
    import numpy as np
    import soundfile as sf

    audio, sample_rate = sf.read(vocals_path, dtype="float32", always_2d=True)
    mono = np.mean(audio, axis=1, dtype=np.float32)
    if sample_rate != REFERENCE_SAMPLE_RATE:
        mono = librosa.resample(
            mono, orig_sr=sample_rate, target_sr=REFERENCE_SAMPLE_RATE, res_type="soxr_hq"
        )
    source_duration_samples = int(len(mono))
    if source_duration_samples == 0:
        raise RuntimeError("separated vocal is empty")
    frame_length = 2048
    analysis_audio = mono
    if len(analysis_audio) < frame_length:
        analysis_audio = np.pad(analysis_audio, (0, frame_length - len(analysis_audio)))
    f0_values, _voiced_flags, voiced_probabilities = librosa.pyin(
        analysis_audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=REFERENCE_SAMPLE_RATE,
        frame_length=frame_length,
        hop_length=REFERENCE_HOP_FRAMES,
        center=False,
    )
    if voiced_probabilities is None:
        voiced_probabilities = np.zeros_like(f0_values)
    payload = build_reference_map(
        f0_values,
        voiced_probabilities,
        source_fingerprint=source_fingerprint,
        source_duration_samples=source_duration_samples,
        separator_profile_value=separator_profile_value,
    )
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, destination)
    return payload


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


def combine_stems_to_flac(sources: list[Path], destination: Path) -> None:
    import numpy as np
    import soundfile as sf

    if not sources:
        raise RuntimeError("no accompaniment stems were provided")
    handles = [sf.SoundFile(path, "r") for path in sources]
    try:
        samplerate = handles[0].samplerate
        channels = handles[0].channels
        frames = handles[0].frames
        if any(
            handle.samplerate != samplerate
            or handle.channels != channels
            or handle.frames != frames
            for handle in handles[1:]
        ):
            raise RuntimeError("Demucs accompaniment stems do not share one audio format")
        peak = 0.0
        while True:
            blocks = [handle.read(262_144, dtype="float32", always_2d=True) for handle in handles]
            if not len(blocks[0]):
                break
            mixed = np.sum(blocks, axis=0, dtype=np.float32)
            peak = max(peak, float(np.max(np.abs(mixed), initial=0.0)))
        scale = min(1.0, 0.999 / peak) if peak > 0 else 1.0
        for handle in handles:
            handle.seek(0)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with sf.SoundFile(
            destination,
            "w",
            samplerate=samplerate,
            channels=channels,
            format="FLAC",
            subtype="PCM_16",
        ) as output_file:
            while True:
                blocks = [handle.read(262_144, dtype="float32", always_2d=True) for handle in handles]
                if not len(blocks[0]):
                    break
                mixed = np.sum(blocks, axis=0, dtype=np.float32) * scale
                output_file.write(mixed)
    finally:
        for handle in handles:
            handle.close()


def discover_ffmpeg_directory() -> Path | None:
    executable = shutil.which("ffmpeg")
    if executable:
        return Path(executable).parent
    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    package_root = local_app_data / "Microsoft" / "WinGet" / "Packages"
    if package_root.is_dir():
        candidates = sorted(
            package_root.glob("Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe"), reverse=True
        )
        if candidates:
            return candidates[0].parent
    return None


def separator_profile(configuration: dict[str, Any]) -> dict[str, Any]:
    return {
        "architecture": str(configuration.get("architecture", "bs-roformer")),
        "model": str(configuration["model"]),
        "batchSize": int(configuration.get("batchSize", 1)),
        "overlap": int(configuration.get("overlap", 8)),
        "fallbackModel": str(configuration.get("fallbackModel", "htdemucs_ft")),
        "fallbackShifts": int(configuration.get("fallbackShifts", 2)),
        "fallbackOverlap": float(configuration.get("fallbackOverlap", 0.5)),
    }


def separator_model_directory(configuration: dict[str, Any]) -> Path:
    override = os.environ.get("KING_AUDIO_SEPARATOR_MODEL_DIR")
    configured = str(configuration.get("modelDirectory", "")).strip()
    if override:
        return Path(override)
    if configured:
        return Path(configured)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA is unavailable")
    return Path(local_app_data) / "club.king.broadcast-control" / "models" / "audio-separator"


def separation_is_current(derived_directory: Path, configuration: dict[str, Any]) -> bool:
    marker = derived_directory / "separation.json"
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return payload.get("profile") == separator_profile(configuration)


def set_moss_memory_released(configuration: dict[str, Any], released: bool) -> bool:
    import requests

    endpoint = str(configuration.get("endpoint", "http://127.0.0.1:30000")).rstrip("/")
    action = "release_memory_occupation" if released else "resume_memory_occupation"
    try:
        response = requests.post(f"{endpoint}/{action}", json={}, timeout=300)
        response.raise_for_status()
        return True
    except requests.RequestException:
        if released:
            return False
        raise RuntimeError("MOSS-Music GPU memory could not be restored")


def separate_demucs_fallback(
    media_path: Path, working_directory: Path, configuration: dict[str, Any]
) -> tuple[Path, Path]:
    demucs_output = working_directory / "demucs"
    _, device, _ = torch_inference_runtime()
    command = [
        sys.executable,
        "-m",
        "demucs",
        "--name",
        str(configuration.get("fallbackModel", "htdemucs_ft")),
        "--shifts",
        str(configuration.get("fallbackShifts", 2)),
        "--overlap",
        str(configuration.get("fallbackOverlap", 0.5)),
        "--float32",
        "--jobs",
        "1",
        "--device",
        device,
        "--out",
        str(demucs_output),
        str(media_path),
    ]
    child_environment = os.environ.copy()
    ffmpeg_directory = discover_ffmpeg_directory()
    if ffmpeg_directory:
        child_environment["PATH"] = (
            f"{ffmpeg_directory}{os.pathsep}{child_environment.get('PATH', '')}"
        )
    result = subprocess.run(
        command,
        text=True,
        capture_output=True,
        errors="replace",
        env=child_environment,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown Demucs error").strip()
        raise RuntimeError(f"Demucs failed: {detail[-4000:]}")
    vocals_wav = next(iter(demucs_output.rglob("vocals.wav")), None)
    accompaniment_wavs = [
        next(iter(demucs_output.rglob(f"{stem}.wav")), None)
        for stem in configuration.get("fallbackAccompaniment", ["drums", "bass", "other"])
    ]
    if vocals_wav is None or any(path is None for path in accompaniment_wavs):
        raise RuntimeError("Demucs completed without the required full stems")
    vocals_flac = working_directory / "vocals.flac"
    accompaniment_flac = working_directory / "no_vocals.flac"
    convert_to_flac(vocals_wav, vocals_flac)
    combine_stems_to_flac(accompaniment_wavs, accompaniment_flac)
    shutil.rmtree(demucs_output, ignore_errors=True)
    return vocals_flac, accompaniment_flac


def separate_roformer(
    media_path: Path, working_directory: Path, configuration: dict[str, Any]
) -> tuple[Path, Path]:
    from audio_separator.separator import Separator

    torch_inference_runtime()
    model_directory = separator_model_directory(configuration)
    model_directory.mkdir(parents=True, exist_ok=True)
    output_directory = working_directory / "roformer"
    output_directory.mkdir(parents=True, exist_ok=True)
    ffmpeg_directory = discover_ffmpeg_directory()
    if ffmpeg_directory:
        os.environ["PATH"] = f"{ffmpeg_directory}{os.pathsep}{os.environ.get('PATH', '')}"
    source_path = str(media_path)
    if source_path.startswith("\\\\?\\"):
        source_path = source_path[4:]
    separator = Separator(
        model_file_dir=str(model_directory),
        output_dir=str(output_directory),
        output_format="FLAC",
        mdxc_params={
            "segment_size": 256,
            "override_model_segment_size": False,
            "batch_size": int(configuration.get("batchSize", 1)),
            "overlap": int(configuration.get("overlap", 8)),
            "pitch_shift": 0,
        },
    )
    separator.load_model(str(configuration["model"]))
    outputs = separator.separate(
        source_path,
        custom_output_names={"Vocals": "vocals", "Instrumental": "no_vocals"},
    )
    vocals_source = output_directory / "vocals.flac"
    accompaniment_source = output_directory / "no_vocals.flac"
    if not outputs or not vocals_source.is_file() or not accompaniment_source.is_file():
        raise RuntimeError("BS-RoFormer completed without the required vocals and instrumental stems")
    vocals_path = working_directory / "vocals.flac"
    accompaniment_path = working_directory / "no_vocals.flac"
    os.replace(vocals_source, vocals_path)
    os.replace(accompaniment_source, accompaniment_path)
    shutil.rmtree(output_directory, ignore_errors=True)
    return vocals_path, accompaniment_path


def separate_stems(
    media_path: Path, working_directory: Path, configuration: dict[str, Any]
) -> tuple[Path, Path]:
    try:
        return separate_roformer(media_path, working_directory, configuration)
    except Exception as error:
        print(f"BS-RoFormer failed; falling back to Demucs: {error}", file=sys.stderr, flush=True)
        return separate_demucs_fallback(media_path, working_directory, configuration)


def windows_to_wsl_path(path: Path) -> str:
    resolved = path.resolve()
    drive = resolved.drive.rstrip(":").lower()
    if not drive:
        return str(resolved)
    tail = resolved.as_posix().split(":", 1)[1].lstrip("/")
    return f"/mnt/{drive}/{tail}"


def extract_json_object(source: str) -> dict[str, Any]:
    def repair_known_delimiters(candidate: str) -> str:
        repaired = re.sub(r'"items"?\s*(?=\[)', '"items":', candidate, count=1)
        repaired = re.sub(r"}\s*(?={)", "},", repaired)
        repaired = re.sub(
            r'(?<=[0-9}\]"])\s*(?="(?:text|startSeconds|endSeconds)"\s*:)',
            ",",
            repaired,
        )
        return re.sub(r",\s*([}\]])", r"\1", repaired)

    def loads_candidate(candidate: str) -> dict[str, Any]:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as original_error:
            repaired = repair_known_delimiters(candidate)
            if repaired == candidate:
                repaired_error = original_error
            else:
                try:
                    return json.loads(repaired)
                except json.JSONDecodeError as error:
                    repaired_error = error

            # Timestamp items are deliberately flat objects. If MOSS corrupts
            # one array delimiter, salvage individually valid items instead of
            # discarding a multi-minute transcription. Invalid items remain
            # excluded and the result still passes normalize_timestamp_items.
            language_match = re.search(r'"language"\s*:\s*"([^"\\]+)"', repaired)
            items_match = re.search(r'"items"\s*:\s*\[', repaired)
            salvaged = []
            if items_match:
                for match in re.finditer(r"\{[^{}]*\}", repaired[items_match.end() :]):
                    try:
                        item = json.loads(repair_known_delimiters(match.group(0)))
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict) and "text" in item:
                        salvaged.append(item)
            if not salvaged:
                # Some long MOSS generations damage an object boundary or add
                # an invalid property name while leaving the three timestamp
                # fields readable. Recover those flat fields directly.
                item_pattern = re.compile(
                    r'"text"\s*:\s*"((?:\\.|[^"\\])*)".*?'
                    r'"(?:startSeconds|start)"\s*:\s*(-?\d+(?:\.\d+)?).*?'
                    r'"(?:endSeconds|end)"\s*:\s*(-?\d+(?:\.\d+)?)',
                    re.DOTALL,
                )
                for match in item_pattern.finditer(repaired):
                    try:
                        item_text = json.loads(f'"{match.group(1)}"')
                    except json.JSONDecodeError:
                        item_text = match.group(1)
                    salvaged.append(
                        {
                            "text": item_text,
                            "startSeconds": float(match.group(2)),
                            "endSeconds": float(match.group(3)),
                        }
                    )
            if salvaged:
                return {
                    "language": language_match.group(1) if language_match else None,
                    "items": salvaged,
                }
            excerpt = cleaned[:1200].replace("\r", " ").replace("\n", " ")
            raise RuntimeError(f"{repaired_error}; MOSS response excerpt: {excerpt}") from repaired_error

    cleaned = re.sub(r"<think>.*?</think>", "", source, flags=re.DOTALL | re.IGNORECASE).strip()
    if "```" in cleaned:
        for section in cleaned.split("```"):
            candidate = section.strip().removeprefix("json").strip()
            if candidate.startswith("{") and candidate.endswith("}"):
                return loads_candidate(candidate)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("MOSS-Music did not return the requested JSON transcript")
    return loads_candidate(cleaned[start : end + 1])


def normalize_timestamp_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = []
    for item in payload.get("items", []):
        text = str(item.get("text", "")).strip()
        start = float(item.get("startSeconds", item.get("start", 0)))
        end = float(item.get("endSeconds", item.get("end", start)))
        if text and start >= 0 and end >= start:
            normalized.append({"text": text, "startSeconds": start, "endSeconds": end})
    return normalized


def transcribe_vocals(
    vocals_path: Path, configuration: dict[str, Any]
) -> tuple[str, str | None, list[dict[str, Any]]]:
    import requests

    endpoint = str(os.environ.get("KING_MOSS_ENDPOINT", configuration["endpoint"])).rstrip("/")
    prompt = (
        "Transcribe all sung lyrics in this audio with native timestamps. "
        "Each item must contain exactly one short singable lyric phrase, normally no longer than "
        "8 seconds. For Chinese lyrics, start a new item after every comma or sentence-ending "
        "punctuation; never combine multiple clauses, verses, or a long paragraph into one item. "
        "Return only one valid JSON object with this exact shape: "
        '{"language":"Chinese","items":[{"text":"lyric phrase",'
        '"startSeconds":0.0,"endSeconds":1.0}]}. '
        "Keep chronological order, omit instrumental-only spans, and do not use markdown."
    )
    response = requests.post(
        f"{endpoint}/generate",
        json={
            "text": prompt,
            "audio_data": windows_to_wsl_path(vocals_path),
            "sampling_params": {
                "max_new_tokens": int(configuration.get("maxTokens", 4096)),
                "temperature": float(configuration.get("temperature", 0.0)),
            },
        },
        timeout=(10, 3600),
    )
    if not response.ok:
        detail = response.text.strip().replace("\n", " ")[:2000]
        raise RuntimeError(f"MOSS-Music HTTP {response.status_code}: {detail}")
    result = response.json()
    raw_text = result.get("text")
    if isinstance(raw_text, list):
        raw_text = "".join(str(item) for item in raw_text)
    transcript = extract_json_object(str(raw_text or ""))
    items = normalize_timestamp_items(transcript)
    plain_text = "\n".join(item["text"] for item in items)
    return plain_text, transcript.get("language"), items


def timestamp_item_is_coarse(item: dict[str, Any]) -> bool:
    duration = float(item["endSeconds"]) - float(item["startSeconds"])
    compact_text = re.sub(r"\s+", "", str(item["text"]))
    return len(compact_text) > 28 or (duration > 12.0 and len(compact_text) > 20)


def split_lyric_text(text: str, max_characters: int = 28) -> list[str]:
    chunks: list[str] = []
    current = ""
    punctuation = "，。！？；：,.!?;:"
    for character in re.sub(r"\s+", " ", text).strip():
        current += character
        if character in punctuation and len(current.strip()) >= 6:
            chunks.append(current.strip())
            current = ""
        elif len(current) >= max_characters:
            split_at = current.rfind(" ", max_characters // 2)
            if split_at > 0:
                chunks.append(current[:split_at].strip())
                current = current[split_at + 1 :]
            else:
                chunks.append(current.strip())
                current = ""
    if current.strip():
        chunks.append(current.strip())
    return chunks


def expand_coarse_timestamp_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    expanded: list[dict[str, Any]] = []
    for item in items:
        if not timestamp_item_is_coarse(item):
            expanded.append(item)
            continue
        chunks = split_lyric_text(str(item["text"]))
        if len(chunks) < 2:
            expanded.append(item)
            continue
        start = float(item["startSeconds"])
        duration = max(0.001, float(item["endSeconds"]) - start)
        total_weight = sum(max(1, len(re.sub(r"\s+", "", chunk))) for chunk in chunks)
        elapsed_weight = 0
        for chunk in chunks:
            weight = max(1, len(re.sub(r"\s+", "", chunk)))
            chunk_start = start + duration * elapsed_weight / total_weight
            elapsed_weight += weight
            chunk_end = start + duration * elapsed_weight / total_weight
            expanded.append(
                {
                    "text": chunk,
                    "startSeconds": round(chunk_start, 3),
                    "endSeconds": round(chunk_end, 3),
                }
            )
    return expanded


def reconcile_overlapping_timestamp_items(
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Discard truncated duplicates when overlapping MOSS passes disagree.

    Segmented transcription can return both a complete phrase and a later,
    shorter prefix fully contained by the complete phrase's time window. The
    short candidate must not overwrite the complete lyric during playback.
    """
    ordered = sorted(items, key=lambda item: (item["startSeconds"], item["endSeconds"]))

    def comparable_text(value: str) -> str:
        return re.sub(r"[\s，。！？；：、,.!?;:]", "", value).casefold()

    reconciled: list[dict[str, Any]] = []
    for index, candidate in enumerate(ordered):
        candidate_text = comparable_text(str(candidate["text"]))
        candidate_start = float(candidate["startSeconds"])
        candidate_end = float(candidate["endSeconds"])
        is_truncated_duplicate = False
        if len(candidate_text) >= 2:
            for other_index, other in enumerate(ordered):
                if index == other_index:
                    continue
                other_text = comparable_text(str(other["text"]))
                other_start = float(other["startSeconds"])
                other_end = float(other["endSeconds"])
                contained_in_time = (
                    candidate_start >= other_start - 1.0
                    and candidate_end <= other_end + 1.0
                )
                proper_fragment = (
                    len(candidate_text) < len(other_text)
                    and (
                        other_text.startswith(candidate_text)
                        or other_text.endswith(candidate_text)
                    )
                )
                if contained_in_time and proper_fragment:
                    is_truncated_duplicate = True
                    break
        if not is_truncated_duplicate:
            reconciled.append(candidate)
    return reconciled


def split_vocals_for_moss(
    vocals_path: Path,
    working_directory: Path,
    *,
    segment_seconds: float = 45.0,
    overlap_seconds: float = 5.0,
) -> list[tuple[Path, float]]:
    import soundfile as sf

    info = sf.info(vocals_path)
    if info.duration <= segment_seconds:
        return [(vocals_path, 0.0)]
    segment_directory = working_directory / "moss-segments"
    segment_directory.mkdir(parents=True, exist_ok=True)
    segment_frames = max(1, int(segment_seconds * info.samplerate))
    overlap_frames = min(segment_frames - 1, max(0, int(overlap_seconds * info.samplerate)))
    step_frames = max(1, segment_frames - overlap_frames)
    segments = []
    with sf.SoundFile(vocals_path, "r") as source:
        start_frame = 0
        index = 0
        while start_frame < len(source):
            source.seek(start_frame)
            audio = source.read(segment_frames, dtype="float32", always_2d=True)
            if len(audio) == 0:
                break
            destination = segment_directory / f"segment-{index:04d}.flac"
            sf.write(destination, audio, info.samplerate, format="FLAC", subtype="PCM_16")
            segments.append((destination, start_frame / info.samplerate))
            if start_frame + len(audio) >= len(source):
                break
            start_frame += step_frames
            index += 1
    return segments


def transcribe_vocals_segmented(
    vocals_path: Path,
    configuration: dict[str, Any],
    working_directory: Path,
) -> tuple[str, str | None, list[dict[str, Any]]]:
    segments = split_vocals_for_moss(vocals_path, working_directory)
    combined_items: list[dict[str, Any]] = []
    language = None
    for segment_index, (segment_path, offset) in enumerate(segments):
        _, segment_language, items = transcribe_vocals(segment_path, configuration)
        language = language or segment_language
        if any(timestamp_item_is_coarse(item) for item in items):
            refined_items: list[dict[str, Any]] = []
            refined_segments = split_vocals_for_moss(
                segment_path,
                working_directory / f"moss-refine-{segment_index:04d}",
                segment_seconds=35.0,
                overlap_seconds=4.0,
            )
            for refined_index, (refined_path, refined_offset) in enumerate(refined_segments):
                _, refined_language, subitems = transcribe_vocals(refined_path, configuration)
                language = language or refined_language
                for item in subitems:
                    local_start = float(item["startSeconds"])
                    local_end = float(item["endSeconds"])
                    if refined_index > 0 and local_end <= 4.0:
                        continue
                    adjusted_start = round(local_start + refined_offset, 3)
                    adjusted = {
                        "text": item["text"],
                        "startSeconds": adjusted_start,
                        "endSeconds": round(local_end + refined_offset, 3),
                    }
                    duplicate = any(
                        previous["text"] == adjusted["text"]
                        and abs(float(previous["startSeconds"]) - adjusted_start) < 6.0
                        for previous in refined_items[-8:]
                    )
                    if not duplicate:
                        refined_items.append(adjusted)
            if refined_items:
                items = refined_items
        for item in items:
            local_start = float(item["startSeconds"])
            local_end = float(item["endSeconds"])
            if segment_index > 0 and local_end <= 5.0:
                continue
            adjusted = {
                "text": item["text"],
                "startSeconds": round(local_start + offset, 3),
                "endSeconds": round(local_end + offset, 3),
            }
            duplicate = any(
                previous["text"] == adjusted["text"]
                and abs(float(previous["startSeconds"]) - adjusted["startSeconds"]) < 10.0
                for previous in combined_items[-8:]
            )
            if not duplicate:
                combined_items.append(adjusted)
    combined_items.sort(key=lambda item: (item["startSeconds"], item["endSeconds"]))
    combined_items = reconcile_overlapping_timestamp_items(combined_items)
    combined_items = expand_coarse_timestamp_items(combined_items)
    plain_text = "\n".join(item["text"] for item in combined_items)
    return plain_text, language, combined_items


def moss_service_status(configuration: dict[str, Any]) -> dict[str, Any]:
    endpoint = str(os.environ.get("KING_MOSS_ENDPOINT", configuration["endpoint"])).rstrip("/")
    try:
        import requests

        response = requests.get(f"{endpoint}/health", timeout=3)
        return {"available": response.ok, "endpoint": endpoint, "statusCode": response.status_code}
    except Exception as error:
        return {"available": False, "endpoint": endpoint, "error": str(error)}


def lrc_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    minutes, remainder = divmod(centiseconds, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"[{minutes:02d}:{whole_seconds:02d}.{fraction:02d}]"


def build_lrc(items: list[dict[str, Any]]) -> str:
    items = reconcile_overlapping_timestamp_items(items)
    items = expand_coarse_timestamp_items(items)
    lines: list[tuple[float, float, str]] = []
    current: list[str] = []
    line_start = 0.0
    previous_end = 0.0

    def flush_current() -> None:
        nonlocal current
        if current:
            lines.append((line_start, previous_end, "".join(current).strip()))
            current = []

    for item in items:
        token = item["text"]
        start = float(item["startSeconds"])
        token_length = len(re.sub(r"\s+", "", token))
        current_length = len(re.sub(r"\s+", "", "".join(current)))
        # MOSS may return either word-sized tokens or complete lyric phrases.
        # Complete phrases must own a display row; only tiny contiguous tokens
        # are joined. Otherwise Korean/English phrases pile into one visual slot.
        should_break = bool(current) and (
            start - previous_end > 1.15 or current_length >= 12 or token_length >= 6
        )
        if should_break:
            flush_current()
        if not current:
            line_start = start
        current.append(token)
        previous_end = float(item["endSeconds"])
        if token_length >= 6:
            flush_current()
    flush_current()

    display_lines: list[tuple[float, str]] = []
    def without_display_punctuation(value: str) -> str:
        return re.sub(r"[，。！？；：、,.!?;:]", "", value).strip()

    for start, end, text in lines:
        if not re.search(r"[\u3400-\u9fff]", text):
            display_lines.append((start, without_display_punctuation(text)))
            continue
        chunks: list[str] = []
        current_chunk = ""
        for character in text:
            current_chunk += character
            compact_length = len(re.sub(r"\s+", "", current_chunk))
            if character in "，。！？；" or compact_length >= 16:
                if current_chunk.strip():
                    chunks.append(current_chunk.strip())
                current_chunk = ""
        if current_chunk.strip():
            chunks.append(current_chunk.strip())
        if len(chunks) < 2:
            display_lines.append((start, without_display_punctuation(text)))
            continue
        duration = max(0.001, end - start)
        weights = [max(1, len(re.sub(r"\s+", "", chunk))) for chunk in chunks]
        total_weight = sum(weights)
        elapsed_weight = 0
        for chunk, weight in zip(chunks, weights):
            display_lines.append((start + duration * elapsed_weight / total_weight, without_display_punctuation(chunk)))
            elapsed_weight += weight
    display_lines.sort(key=lambda line: line[0])
    return "\n".join(f"{lrc_timestamp(start)}{text}" for start, text in display_lines if text) + "\n"


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
        separator_configuration = pipeline["separator"]
        if (
            not vocals_path.is_file()
            or not accompaniment_path.is_file()
            or not separation_is_current(derived_directory, separator_configuration)
        ):
            update_job(database_path, job_id, status="running", stage="separating-high-quality")
            moss_memory_released = set_moss_memory_released(pipeline["moss"], True)
            try:
                separated_vocals, separated_accompaniment = separate_stems(
                    media_path, working_directory, separator_configuration
                )
            finally:
                if moss_memory_released:
                    update_job(database_path, job_id, status="running", stage="restoring-moss")
                    set_moss_memory_released(pipeline["moss"], False)
            os.replace(separated_vocals, vocals_path)
            os.replace(separated_accompaniment, accompaniment_path)
            separation_marker = derived_directory / "separation.json.tmp"
            separation_marker.write_text(
                json.dumps({"profile": separator_profile(separator_configuration)}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(separation_marker, derived_directory / "separation.json")
        current_separator_profile = separator_profile(separator_configuration)
        reference_path = derived_directory / "reference.json"
        if not reference_map_is_current(
            reference_path, job["media_fingerprint"], current_separator_profile
        ):
            update_job(database_path, job_id, status="running", stage="analyzing-reference")
            generate_reference_map(
                vocals_path,
                reference_path,
                job["media_fingerprint"],
                current_separator_profile,
            )
        lyrics_path = derived_directory / "lyrics.lrc"
        words_path = derived_directory / "lyrics.words.json"
        text_path = derived_directory / "lyrics.txt"
        if lyrics_path.is_file() and words_path.is_file() and text_path.is_file():
            update_job(database_path, job_id, status="running", stage="reusing-lyrics")
            lyrics_payload = json.loads(words_path.read_text(encoding="utf-8"))
            language = str(lyrics_payload.get("language", "Unknown"))
            words = normalize_timestamp_items(lyrics_payload)
            if not words:
                raise RuntimeError("existing native timestamp items are empty")
            temporary_lrc = derived_directory / "lyrics.lrc.tmp"
            temporary_lrc.write_text(build_lrc(words), encoding="utf-8")
            os.replace(temporary_lrc, lyrics_path)
        else:
            update_job(database_path, job_id, status="running", stage="transcribing")
            text, language, words = transcribe_vocals_segmented(
                vocals_path, pipeline["moss"], working_directory
            )
            if not text:
                raise RuntimeError("MOSS-Music returned empty lyrics")
            (working_directory / "lyrics.txt").write_text(text + "\n", encoding="utf-8")
            if not words:
                raise RuntimeError("MOSS-Music returned no native timestamp items")
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
            "separatorProfile": separator_profile(pipeline["separator"]),
            "asrModel": pipeline["moss"]["model"],
            "alignerModel": "MOSS-Music native timestamps",
            "referenceMapFile": "reference.json",
            "referenceMapVersion": 1,
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
    compute = compute_status()
    moss_service = moss_service_status(pipeline["moss"])
    separator_directory = separator_model_directory(pipeline["separator"])
    separator_model = separator_directory / str(pipeline["separator"]["model"])
    separator_ready = separator_model.is_file()
    return {
        "ok": (
            sys.version_info[:2] == (3, 12)
            and all(modules.values())
            and moss_service["available"]
            and separator_ready
            and (compute["cudaAvailable"] or not compute["requireCuda"])
            and (compute["requestedDtype"] != "bfloat16" or compute["bf16Supported"])
        ),
        "python": platform.python_version(),
        "pythonSupported": sys.version_info[:2] == (3, 12),
        "pipelineVersion": pipeline["pipelineVersion"],
        "asrModel": pipeline["moss"]["model"],
        "alignerModel": "MOSS-Music native timestamps",
        "separatorModel": pipeline["separator"]["model"],
        "concurrency": pipeline["concurrency"],
        "compute": compute,
        "modules": modules,
        "ffmpeg": str(discover_ffmpeg_directory() or ""),
        "modelSources": {
            "moss": moss_service["endpoint"],
            "separator": str(separator_model),
        },
        "localModelsReady": moss_service["available"] and separator_ready,
        "separatorModelReady": separator_ready,
        "mossService": moss_service,
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
        ensure_job_table(args.database)
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
        ensure_job_table(args.database)
        recover_running_jobs(args.database)
        last_wait_reason = None
        while True:
            report = preflight(args.database)
            if report["ok"]:
                break
            moss = report.get("mossService", {})
            wait_reason = moss.get("error") or "MOSS-Music/CUDA environment is not ready"
            if wait_reason != last_wait_reason:
                print(f"KING CLUB AI worker waiting: {wait_reason}", flush=True)
                last_wait_reason = wait_reason
            try:
                time.sleep(max(3.0, args.poll_seconds))
            except KeyboardInterrupt:
                return 130
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
                    status="queued",
                    stage="retrying",
                    error_message="worker interrupted; automatic retry pending",
                )
                return 130
            except Exception as error:
                print(f"AI job {job['id']} failed: {error}", file=sys.stderr, flush=True)
                message = str(error).lower()
                retryable_service_error = any(
                    marker in message
                    for marker in (
                        "connection refused",
                        "failed to establish a new connection",
                        "max retries exceeded",
                        "connection aborted",
                        "connection reset",
                    )
                )
                retryable_format_error = int(job.get("attempts", 0)) < 3 and any(
                    marker in message
                    for marker in (
                        "expecting ',' delimiter",
                        "expecting ':' delimiter",
                        "unterminated string",
                        "extra data",
                    )
                )
                if retryable_service_error or retryable_format_error:
                    update_job(
                        args.database,
                        int(job["id"]),
                        status="queued",
                        stage="waiting-service" if retryable_service_error else "retrying-format",
                        error_message=(
                            "MOSS-Music service unavailable; automatic retry pending"
                            if retryable_service_error
                            else "MOSS-Music response format incomplete; automatic retry pending"
                        ),
                    )
                    time.sleep(max(3.0, args.poll_seconds))
    parser.error("choose --preflight, --once or --run")


if __name__ == "__main__":
    raise SystemExit(main())
