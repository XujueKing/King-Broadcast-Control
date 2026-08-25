param(
  [string]$Python = "",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128",
  [string]$SeparatorModelDirectory = "D:\AI-Models\audio-separator"
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
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip." }
& $EnvironmentPython -m pip install torch torchvision torchaudio --index-url $TorchIndexUrl
if ($LASTEXITCODE -ne 0) { throw "Failed to install the CUDA PyTorch runtime." }
& $EnvironmentPython -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) { throw "Failed to install KING CLUB AI worker requirements." }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "Installing FFmpeg fallback decoder for malformed customer media..."
  winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "Installing FFmpeg failed." }
}

$Ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $Ffmpeg) {
  $WingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  $Ffmpeg = Get-ChildItem -LiteralPath $WingetPackages -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($Ffmpeg) {
    $env:PATH = "$(Split-Path -Parent $Ffmpeg.FullName);$env:PATH"
  }
}

New-Item -ItemType Directory -Force -Path $SeparatorModelDirectory | Out-Null
$Separator = Join-Path $EnvironmentDirectory "Scripts\audio-separator.exe"
& $Separator --model_file_dir $SeparatorModelDirectory --download_model_only -m "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
if ($LASTEXITCODE -ne 0) { throw "Failed to download the BS-RoFormer separator model." }

& $EnvironmentPython (Join-Path $ProjectRoot "ai-worker\check_cuda.py")
if ($LASTEXITCODE -ne 0) { throw "KING CLUB CUDA runtime validation failed." }

Write-Host "KING CLUB Windows AI worker ready. Start the MOSS-Music WSL service before running preflight."
