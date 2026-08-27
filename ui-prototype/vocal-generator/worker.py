"""KING CLUB offline singer-reference worker.

The six accepted profile recordings are immutable inputs. This worker derives a
short voice reference, converts the already-separated song vocal with Seed-VC,
and atomically publishes the resulting FLAC beside the song analysis artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
import soundfile as sf


REFERENCE_SAMPLE_RATE = 48_000
REFERENCE_PIECE_SECONDS = 2.25
REFERENCE_GAP_SECONDS = 0.06


def select_balanced_voice_piece(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Pick a dense voiced window without modifying the captured source file."""
    window = min(audio.size, int(sample_rate * REFERENCE_PIECE_SECONDS))
    if window <= 0:
        return np.zeros(0, dtype=np.float32)
    if audio.size > window:
        # Clip the energy contribution so one plosive cannot win over a stable note.
        power = np.minimum(np.square(audio, dtype=np.float64), 0.25**2)
        cumulative = np.pad(np.cumsum(power), (1, 0))
        scores = cumulative[window:] - cumulative[:-window]
        start = int(np.argmax(scores))
        piece = audio[start : start + window].copy()
    else:
        piece = audio.copy()

    active = np.abs(piece) >= 0.0025
    if active.any():
        rms = float(np.sqrt(np.mean(np.square(piece[active], dtype=np.float64))))
        if rms > 0:
            piece *= min(10 ** (-22 / 20) / rms, 3.0)
    peak = float(np.max(np.abs(piece), initial=0.0))
    if peak > 0.78:
        piece *= 0.78 / peak
    fade = min(int(sample_rate * 0.025), piece.size // 2)
    if fade:
        ramp = np.linspace(0.0, 1.0, fade, endpoint=False, dtype=np.float32)
        piece[:fade] *= ramp
        piece[-fade:] *= ramp[::-1]
    return piece.astype(np.float32, copy=False)


def read_request(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def update_request(path: Path, **changes: object) -> dict:
    request = read_request(path)
    request.update(changes)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(request, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, path)
    return request


def build_voice_reference(sample_paths: list[str], destination: Path) -> None:
    if not sample_paths:
        raise RuntimeError("歌手包没有可用的原始样本")

    target_rate = REFERENCE_SAMPLE_RATE
    pieces: list[np.ndarray] = []
    for value in sample_paths:
        path = Path(value)
        if not path.is_file():
            raise RuntimeError(f"歌手原始样本不存在：{path}")
        audio, rate = sf.read(path, dtype="float32", always_2d=True)
        mono = audio.mean(axis=1)
        if rate != target_rate:
            import librosa

            mono = librosa.resample(mono, orig_sr=rate, target_sr=target_rate)
        # Seed-VC uses at most 25 seconds of prompt audio. Taking one dense,
        # short piece from every prompt preserves high/low/sustain coverage and
        # leaves a much longer generation context than the old 28-second concat.
        piece = select_balanced_voice_piece(mono, target_rate)
        if piece.size:
            pieces.append(piece)
            pieces.append(
                np.zeros(int(target_rate * REFERENCE_GAP_SECONDS), dtype=np.float32)
            )

    reference = np.concatenate(pieces[:-1]) if pieces else np.zeros(1, dtype=np.float32)
    peak = float(np.max(np.abs(reference)))
    if peak < 0.003:
        raise RuntimeError("歌手原始样本电平过低")
    if peak > 0.92:
        reference = reference * (0.92 / peak)
    destination.parent.mkdir(parents=True, exist_ok=True)
    sf.write(destination, reference, target_rate, subtype="PCM_24")


def seed_vc_entrypoint(runtime: Path) -> Path:
    """Create a local Seed-VC entrypoint that does not require TorchCodec.

    Recent torchaudio releases delegate file writing to TorchCodec, whose DLL
    loader requires shared FFmpeg builds. KING CLUB already ships a working
    ffmpeg executable and soundfile, so write the generated PCM directly with
    soundfile instead of adding another native runtime dependency.
    """
    source = runtime / "inference.py"
    if not source.is_file():
        raise RuntimeError(f"Seed-VC inference entrypoint missing: {source}")

    patched = runtime / "inference.king.py"
    content = source.read_text(encoding="utf-8")
    if "import soundfile as sf" not in content:
        content = content.replace("import torchaudio\n", "import torchaudio\nimport soundfile as sf\n", 1)
    old_save = (
        "torchaudio.save(os.path.join(args.output, "
        "f\"vc_{source_name}_{target_name}_{length_adjust}_{diffusion_steps}_{inference_cfg_rate}.wav\"), "
        "vc_wave.cpu(), sr)"
    )
    new_save = (
        "sf.write(os.path.join(args.output, "
        "f\"vc_{source_name}_{target_name}_{length_adjust}_{diffusion_steps}_{inference_cfg_rate}.wav\"), "
        "vc_wave.squeeze(0).cpu().numpy(), sr, subtype=\"PCM_24\")"
    )
    if old_save not in content:
        raise RuntimeError("Seed-VC output writer signature changed; refusing an unsafe patch")
    content = content.replace(old_save, new_save, 1)
    patched.write_text(content, encoding="utf-8")
    return patched


def run(request_path: Path, runtime: Path, ffmpeg: Path) -> None:
    request = update_request(
        request_path,
        state="preparing_reference",
        progress=0.05,
        startedAtUnixMs=int(time.time() * 1000),
        error=None,
    )
    source = Path(request["sourceVocalsPath"])
    output = Path(request["outputReferencePath"])
    if not source.is_file():
        raise RuntimeError(f"歌曲原唱分离轨不存在：{source}")

    work_root = request_path.parent / (request_path.stem + "-work")
    work_root.mkdir(parents=True, exist_ok=True)
    reference = work_root / "singer-reference.wav"
    build_voice_reference(request["samplePaths"], reference)
    update_request(request_path, state="converting_voice", progress=0.15)
    reference_info = sf.info(reference)
    update_request(
        request_path,
        referencePromptSeconds=round(reference_info.frames / reference_info.samplerate, 3),
        referencePromptStrategy="balanced-dense-v2",
    )

    seed_output = work_root / "seed-output"
    if seed_output.exists():
        shutil.rmtree(seed_output)
    seed_output.mkdir(parents=True)
    command = [
        sys.executable,
        str(seed_vc_entrypoint(runtime)),
        "--source",
        str(source),
        "--target",
        str(reference),
        "--output",
        str(seed_output),
        "--diffusion-steps",
        "40",
        "--length-adjust",
        "1.0",
        "--inference-cfg-rate",
        "0.7",
        "--f0-condition",
        "True",
        "--auto-f0-adjust",
        "False",
        "--semi-tone-shift",
        "0",
        "--fp16",
        "True",
    ]
    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    environment["HF_HUB_CACHE"] = str(runtime / "checkpoints" / "hf_cache")
    log_path = work_root / "generator.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.run(
            command,
            cwd=runtime,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    if process.returncode != 0:
        raise RuntimeError(f"Seed-VC 生成失败，日志：{log_path}")

    candidates = sorted(seed_output.glob("vc_*.wav"), key=lambda path: path.stat().st_mtime)
    if not candidates:
        raise RuntimeError("Seed-VC 未生成输出文件")
    update_request(request_path, state="encoding", progress=0.92)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(".tmp.flac")
    encode = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(candidates[-1]),
            "-c:a",
            "flac",
            "-compression_level",
            "8",
            str(temporary_output),
        ],
        check=False,
    )
    if encode.returncode != 0 or not temporary_output.is_file():
        raise RuntimeError("女声参考轨 FLAC 编码失败")
    os.replace(temporary_output, output)
    update_request(
        request_path,
        state="ready",
        progress=1.0,
        completedAtUnixMs=int(time.time() * 1000),
        outputReferencePath=str(output),
        error=None,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()
    lock_path = args.request.with_suffix(args.request.suffix + ".lock")
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return 0
    os.close(lock)
    try:
        run(args.request, args.runtime, args.ffmpeg)
        return 0
    except Exception as error:  # keep the UI-visible failure actionable
        try:
            update_request(
                args.request,
                state="failed",
                error=str(error),
                failedAtUnixMs=int(time.time() * 1000),
            )
        except Exception:
            pass
        return 1
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
