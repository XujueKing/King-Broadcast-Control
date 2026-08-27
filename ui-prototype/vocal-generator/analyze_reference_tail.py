"""Compare source and converted vocal pitch/energy over a selected time range."""

from __future__ import annotations

import argparse
from pathlib import Path

import librosa
import numpy as np


def load_track(path: Path, sample_rate: int, offset: float, duration: float):
    audio, _ = librosa.load(
        path, sr=sample_rate, mono=True, offset=offset, duration=duration
    )
    pitch = librosa.yin(
        audio,
        fmin=65,
        fmax=900,
        sr=sample_rate,
        frame_length=2048,
        hop_length=256,
    )
    rms = librosa.feature.rms(
        y=audio, frame_length=2048, hop_length=256
    )[0]
    return pitch, rms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("converted", type=Path)
    parser.add_argument("--start", type=float, default=228.0)
    parser.add_argument("--end", type=float, default=265.0)
    parser.add_argument("--window", type=float, default=0.5)
    args = parser.parse_args()

    sample_rate = 24_000
    tracks = [
        load_track(path, sample_rate, args.start, args.end - args.start)
        for path in (args.source, args.converted)
    ]
    print("sec src_hz out_hz src_db out_db delta_semitones")
    for second in np.arange(args.start, args.end, args.window):
        values = []
        for pitch, rms in tracks:
            first = int((second - args.start) * sample_rate / 256)
            last = int((second + args.window - args.start) * sample_rate / 256)
            window_rms = rms[first:last]
            db = float(
                20 * np.log10(max(float(np.sqrt(np.mean(window_rms**2))), 1e-9))
            )
            voiced = window_rms > 10 ** (-45 / 20)
            hz = float(np.median(pitch[first:last][voiced])) if voiced.any() else np.nan
            values.append((hz, db))
        delta = (
            12 * np.log2(values[1][0] / values[0][0])
            if np.isfinite(values[0][0]) and np.isfinite(values[1][0])
            else np.nan
        )
        print(
            f"{second:6.1f} {values[0][0]:7.1f} {values[1][0]:7.1f} "
            f"{values[0][1]:6.1f} {values[1][1]:6.1f} {delta:7.2f}"
        )


if __name__ == "__main__":
    main()
