$ErrorActionPreference = "Stop"

$version = "v0.1.2"
$assetName = "kgm-decoder-windows-amd64.exe"
$expectedHash = "8fd50c8f995d327c16755fd4d355143524cc9eacb6d52cd4e43f633e150da7aa"
$downloadUrl = "https://github.com/ghtz08/kugou-kgm-decoder/releases/download/$version/$assetName"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $projectRoot ".local-tools\kgm-decoder"
$targetExecutable = Join-Path $targetDirectory "kgm-decoder.exe"
$cacheDirectory = Join-Path $env:TEMP "king-club-kgm-decoder-$version"
$downloadPath = Join-Path $cacheDirectory $assetName

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $downloadPath)) {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadPath
}
$actualHash = Get-Sha256Hex -Path $downloadPath
if ($actualHash -ne $expectedHash) {
  throw "kgm-decoder checksum mismatch. Expected $expectedHash, received $actualHash."
}
Copy-Item -LiteralPath $downloadPath -Destination $targetExecutable -Force
Write-Host "KING CLUB KGMA decoder ready: $targetExecutable"
Write-Host "SHA-256: $actualHash"
