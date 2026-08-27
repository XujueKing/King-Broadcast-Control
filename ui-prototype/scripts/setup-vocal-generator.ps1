param(
  [string]$Python = "",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128",
  [string]$SeedVcRepository = "https://github.com/Plachtaa/seed-vc.git"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentDirectory = Join-Path $ProjectRoot ".venv-vocal-generator"
$AppDataRoot = Join-Path $env:APPDATA "club.king.broadcast-control"
$ModelDirectory = Join-Path $AppDataRoot "models\vocal-generator"
$RuntimeDirectory = Join-Path $ModelDirectory "seed-vc"
$WorkerSource = Join-Path $ProjectRoot "vocal-generator\worker.py"
$WorkerDestination = Join-Path $ModelDirectory "worker.py"
$ManifestPath = Join-Path $ModelDirectory "manifest.json"

if (-not $Python) {
  $Python = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null)
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw "Python 3.11 not found. Install it or pass -Python with its absolute path."
}

New-Item -ItemType Directory -Force -Path $ModelDirectory | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory "inference.py") -PathType Leaf)) {
  if (Test-Path -LiteralPath $RuntimeDirectory) {
    throw "Incomplete Seed-VC directory exists: $RuntimeDirectory"
  }
  & git clone --depth 1 $SeedVcRepository $RuntimeDirectory
  if ($LASTEXITCODE -ne 0) { throw "Failed to download the official Seed-VC runtime." }
}

if (-not (Test-Path -LiteralPath (Join-Path $EnvironmentDirectory "Scripts\python.exe") -PathType Leaf)) {
  & $Python -m venv $EnvironmentDirectory
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the vocal generator environment." }
}
$EnvironmentPython = Join-Path $EnvironmentDirectory "Scripts\python.exe"
& $EnvironmentPython -m pip install --upgrade pip wheel setuptools
if ($LASTEXITCODE -ne 0) { throw "Failed to update pip." }
& $EnvironmentPython -m pip install torch torchvision torchaudio --index-url $TorchIndexUrl
if ($LASTEXITCODE -ne 0) { throw "Failed to install CUDA PyTorch." }
$Packages = @(
  "accelerate"
  "scipy==1.13.1"
  "librosa==0.10.2"
  "huggingface-hub>=0.28.1"
  "munch==4.0.0"
  "einops==0.8.0"
  "descript-audio-codec==1.0.0"
  "pydub==0.25.1"
  "resemblyzer"
  "jiwer==3.0.3"
  "transformers==4.46.3"
  "soundfile==0.12.1"
  "numpy==1.26.4"
  "hydra-core==1.3.2"
  "pyyaml"
  "python-dotenv"
  "tqdm"
)
& $EnvironmentPython -m pip install @Packages
if ($LASTEXITCODE -ne 0) { throw "Failed to install Seed-VC inference dependencies." }

$Ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $Ffmpeg) {
  $WingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  $Ffmpeg = Get-ChildItem -LiteralPath $WingetPackages -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
}
if (-not $Ffmpeg) { throw "FFmpeg not found. Run npm run setup:audio-ai first." }
$FfmpegPath = if ($Ffmpeg.Source) { $Ffmpeg.Source } else { $Ffmpeg.FullName }

Copy-Item -LiteralPath $WorkerSource -Destination $WorkerDestination -Force
& $EnvironmentPython -c "import torch, torchaudio, librosa, soundfile, transformers; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) { throw "Vocal generator CUDA validation failed." }

$Manifest = [ordered]@{
  schemaVersion = 1
  engine = "Seed-VC"
  repository = $SeedVcRepository
  python = $EnvironmentPython
  runtimeRoot = $RuntimeDirectory
  workerScript = $WorkerDestination
  ffmpeg = $FfmpegPath
  installedAt = (Get-Date).ToString("o")
}
$Manifest | ConvertTo-Json | Set-Content -LiteralPath $ManifestPath -Encoding utf8
Write-Host "KING CLUB vocal generator ready: $ManifestPath"
