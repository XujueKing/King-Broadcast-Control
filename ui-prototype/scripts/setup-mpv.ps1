param(
  [ValidateSet("v3", "baseline")]
  [string]$Variant = "v3"
)

$ErrorActionPreference = "Stop"

$release = @{
  Tag = "20260814"
  Commit = "7b8915bc1d"
  V3Archive = "mpv-x86_64-v3-20260814-git-7b8915bc1d.7z"
  V3Sha256 = "c71b4e7c643822565bc5c516320a1df25913268bbc13e707089e17986c5b889c"
  BaselineArchive = "mpv-x86_64-20260814-git-7b8915bc1d.7z"
  BaselineSha256 = "1bf3b029da2c98e605e00e85f21ee3142f22a1dcc4ceb5c827b5c51e36e390f9"
}

$archiveName = if ($Variant -eq "v3") { $release.V3Archive } else { $release.BaselineArchive }
$expectedHash = if ($Variant -eq "v3") { $release.V3Sha256 } else { $release.BaselineSha256 }
$downloadUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$($release.Tag)/$archiveName"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $projectRoot ".local-tools\mpv"
$cacheDirectory = Join-Path $env:TEMP "king-club-mpv-$($release.Tag)-$Variant"
$archivePath = Join-Path $cacheDirectory $archiveName
$extractDirectory = Join-Path $cacheDirectory "extract"

New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $extractDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
}

$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "mpv archive checksum mismatch. Expected $expectedHash, received $actualHash."
}

tar -xf $archivePath -C $extractDirectory
$sourceExecutable = Join-Path $extractDirectory "mpv.exe"
if (-not (Test-Path -LiteralPath $sourceExecutable)) {
  throw "mpv.exe was not found after extracting $archiveName."
}

$targetExecutable = Join-Path $targetDirectory "mpv.exe"
Copy-Item -LiteralPath $sourceExecutable -Destination $targetExecutable -Force

Write-Host "KING CLUB mpv runtime ready: $targetExecutable"
& $targetExecutable --version | Select-Object -First 4
