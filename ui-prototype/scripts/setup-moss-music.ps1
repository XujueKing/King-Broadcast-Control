param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$SourceDirectory = "D:\AI-Models\MOSS-Music",
  [string]$ModelDirectory = "D:\AI-Models\MOSS-Music-8B-Thinking",
  [string]$LinuxVenv = "~/.venvs/moss-music",
  [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
  param([scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Native command failed with exit code $LASTEXITCODE"
  }
}

function Convert-ToWslPath {
  param([string]$WindowsPath)
  $fullPath = [System.IO.Path]::GetFullPath($WindowsPath)
  $drive = $fullPath.Substring(0, 1).ToLowerInvariant()
  $tail = $fullPath.Substring(3).Replace('\', '/')
  return "/mnt/$drive/$tail"
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "WSL2 is required for the MOSS-Music SGLang service."
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory "sglang\python\pyproject.toml"))) {
  throw "MOSS-Music source is missing at $SourceDirectory. Clone https://github.com/OpenMOSS/MOSS-Music there first."
}

$sourceWsl = Convert-ToWslPath $SourceDirectory
$modelWsl = Convert-ToWslPath $ModelDirectory
$linuxHome = (& wsl.exe -d $Distro -- bash -lc 'printf %s "$HOME"').Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxHome) {
  throw "Cannot resolve the Linux home directory for WSL distro $Distro."
}
$venvWsl = if ($LinuxVenv.StartsWith("~/")) {
  "$linuxHome/$($LinuxVenv.Substring(2))"
} else {
  $LinuxVenv
}
$downloadCommand = if ($SkipModelDownload) { "" } else {
  "mkdir -p '$modelWsl' && '$venvWsl/bin/hf' download OpenMOSS-Team/MOSS-Music-8B-Thinking --local-dir '$modelWsl'"
}
$linuxCommand = @"
set -euo pipefail
sudo apt-get update
sudo apt-get install -y python3.12-venv python3.12-dev ffmpeg build-essential ninja-build
python3.12 -m venv '$venvWsl'
'$venvWsl/bin/python' -m pip install --upgrade pip setuptools wheel
'$venvWsl/bin/pip' install -e '$sourceWsl/sglang/python[all]'
'$venvWsl/bin/pip' install nvidia-cudnn-cu12==9.16.0.29
$downloadCommand
'$venvWsl/bin/python' -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))"
"@

Write-Host "Installing the MOSS-Music service in WSL2. Model storage: $ModelDirectory"
Invoke-Native { wsl.exe -d $Distro -- bash -lc $linuxCommand }
Write-Host "MOSS-Music setup complete. E: is not used by this runtime."
