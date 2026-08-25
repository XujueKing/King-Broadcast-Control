"""Fail fast when the project virtual environment cannot use CUDA."""

from __future__ import annotations

import json

import torch


report = {
    "torch": torch.__version__,
    "cudaBuild": torch.version.cuda,
    "cudaAvailable": torch.cuda.is_available(),
    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "computeCapability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None,
    "bf16Supported": torch.cuda.is_bf16_supported() if torch.cuda.is_available() else False,
}
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report["cudaAvailable"]:
    raise SystemExit("CUDA PyTorch runtime is unavailable; refusing a CPU-only KING CLUB AI setup.")
if not report["bf16Supported"]:
    raise SystemExit("The selected GPU does not support the required bfloat16 inference mode.")
