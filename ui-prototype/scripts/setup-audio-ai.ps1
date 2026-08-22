param(
  [string]$Python = "",
  [switch]$SkipModels
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentDirectory = Join-Path $ProjectRoot ".venv-audio-ai"
$Requirements = Join-Path $ProjectRoot "ai-worker\requirements.txt"

if (-not $Python) {
  $Python = (& py -3.12 -c "import sys; print(sys.executable)" 2>$null)
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw "Python 3.12 not found. Install it or pass -Python with its absolute path."
}

& $Python -m venv $EnvironmentDirectory
$EnvironmentPython = Join-Path $EnvironmentDirectory "Scripts\python.exe"
& $EnvironmentPython -m pip install --upgrade pip
& $EnvironmentPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
& $EnvironmentPython -m pip install -r $Requirements

if (-not $SkipModels) {
  $ModelScope = Join-Path $EnvironmentDirectory "Scripts\modelscope.exe"
  $ModelsDirectory = Join-Path $ProjectRoot ".local-tools\models"
  New-Item -ItemType Directory -Force -Path $ModelsDirectory | Out-Null
  & $ModelScope download --model Qwen/Qwen3-ASR-1.7B `
    --local_dir (Join-Path $ModelsDirectory "Qwen3-ASR-1.7B")
  & $ModelScope download --model Qwen/Qwen3-ForcedAligner-0.6B `
    --local_dir (Join-Path $ModelsDirectory "Qwen3-ForcedAligner-0.6B")
}

& $EnvironmentPython (Join-Path $ProjectRoot "ai-worker\worker.py") --preflight
