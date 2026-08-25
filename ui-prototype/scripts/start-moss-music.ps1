param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$ModelDirectory = "D:\AI-Models\MOSS-Music-8B-Thinking",
  [string]$LinuxVenv = "~/.venvs/moss-music",
  [int]$Port = 30000,
  [double]$MemoryFraction = 0.80
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath (Join-Path $ModelDirectory "config.json")) -or
    -not (Test-Path -LiteralPath (Join-Path $ModelDirectory "model.safetensors.index.json"))) {
  throw "MOSS-Music model is incomplete or missing at $ModelDirectory. Run npm run setup:moss-music first."
}
$modelIndex = Get-Content -Raw -LiteralPath (Join-Path $ModelDirectory "model.safetensors.index.json") | ConvertFrom-Json
$modelShards = $modelIndex.weight_map.PSObject.Properties.Value | Sort-Object -Unique
foreach ($shard in $modelShards) {
  $shardPath = Join-Path $ModelDirectory $shard
  if (-not (Test-Path -LiteralPath $shardPath) -or
      (Get-Item -LiteralPath $shardPath).Length -eq 0 -or
      (Test-Path -LiteralPath "$shardPath.aria2")) {
    throw "MOSS-Music model shard is incomplete or missing: $shardPath"
  }
}

$fullPath = [System.IO.Path]::GetFullPath($ModelDirectory)
$drive = $fullPath.Substring(0, 1).ToLowerInvariant()
$tail = $fullPath.Substring(3).Replace('\', '/')
$modelWsl = "/mnt/$drive/$tail"
$linuxHome = (& wsl.exe -d $Distro -- bash -lc 'printf %s "$HOME"').Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxHome) {
  throw "Cannot resolve the Linux home directory for WSL distro $Distro."
}
$venvWsl = if ($LinuxVenv.StartsWith("~/")) {
  "$linuxHome/$($LinuxVenv.Substring(2))"
} else {
  $LinuxVenv
}
$command = @"
set -euo pipefail
export LD_LIBRARY_PATH='$venvWsl/lib/python3.12/site-packages/nvidia/cuda_runtime/lib':/usr/local/cuda/lib64
exec '$venvWsl/bin/sglang' serve \
  --model-path '$modelWsl' \
  --host 0.0.0.0 \
  --port $Port \
  --trust-remote-code \
  --enable-memory-saver \
  --enable-weights-cpu-backup \
  --mem-fraction-static $MemoryFraction
"@

Write-Host "Starting MOSS-Music-8B-Thinking on http://127.0.0.1:$Port (Ctrl+C stops it)."
Write-Host "Model: $ModelDirectory"
& wsl.exe -d $Distro -- bash -lc $command
exit $LASTEXITCODE
