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
  V3DevArchive = "mpv-dev-x86_64-v3-20260814-git-7b8915bc1d.7z"
  V3DevSha256 = "d4d095c6c504a202ec31a3fca5132a53e5f72bfb6e484f960f4850c19f4d62cc"
  BaselineArchive = "mpv-x86_64-20260814-git-7b8915bc1d.7z"
  BaselineSha256 = "1bf3b029da2c98e605e00e85f21ee3142f22a1dcc4ceb5c827b5c51e36e390f9"
  BaselineDevArchive = "mpv-dev-x86_64-20260814-git-7b8915bc1d.7z"
  BaselineDevSha256 = "0af22b28e920620036d3ae08fd9283156dc9af0420bf4df84b0e02282094599c"
}

$archiveName = if ($Variant -eq "v3") { $release.V3Archive } else { $release.BaselineArchive }
$expectedHash = if ($Variant -eq "v3") { $release.V3Sha256 } else { $release.BaselineSha256 }
$devArchiveName = if ($Variant -eq "v3") { $release.V3DevArchive } else { $release.BaselineDevArchive }
$devExpectedHash = if ($Variant -eq "v3") { $release.V3DevSha256 } else { $release.BaselineDevSha256 }
$downloadUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$($release.Tag)/$archiveName"
$devDownloadUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$($release.Tag)/$devArchiveName"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $projectRoot ".local-tools\mpv"
$cacheDirectory = Join-Path $env:TEMP "king-club-mpv-$($release.Tag)-$Variant"
$archivePath = Join-Path $cacheDirectory $archiveName
$devArchivePath = Join-Path $cacheDirectory $devArchiveName
$extractDirectory = Join-Path $cacheDirectory "extract"
$devExtractDirectory = Join-Path $cacheDirectory "dev-extract"

New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $extractDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $devExtractDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
}
if (-not (Test-Path -LiteralPath $devArchivePath)) {
  Invoke-WebRequest -Uri $devDownloadUrl -OutFile $devArchivePath
}

$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "mpv archive checksum mismatch. Expected $expectedHash, received $actualHash."
}
$devActualHash = (Get-FileHash -LiteralPath $devArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($devActualHash -ne $devExpectedHash) {
  throw "libmpv archive checksum mismatch. Expected $devExpectedHash, received $devActualHash."
}

tar -xf $archivePath -C $extractDirectory
tar -xf $devArchivePath -C $devExtractDirectory
$sourceExecutable = Join-Path $extractDirectory "mpv.exe"
if (-not (Test-Path -LiteralPath $sourceExecutable)) {
  throw "mpv.exe was not found after extracting $archiveName."
}

$targetExecutable = Join-Path $targetDirectory "mpv.exe"
Copy-Item -LiteralPath $sourceExecutable -Destination $targetExecutable -Force

$sourceLibrary = Join-Path $devExtractDirectory "libmpv-2.dll"
$sourceHeaders = Join-Path $devExtractDirectory "include\mpv"
if (-not (Test-Path -LiteralPath $sourceLibrary) -or -not (Test-Path -LiteralPath $sourceHeaders)) {
  throw "libmpv runtime or headers were not found after extracting $devArchiveName."
}
Copy-Item -LiteralPath $sourceLibrary -Destination (Join-Path $targetDirectory "libmpv-2.dll") -Force
Copy-Item -LiteralPath $sourceHeaders -Destination (Join-Path $targetDirectory "include") -Recurse -Force

Write-Host "KING CLUB mpv runtime ready: $targetExecutable"
Write-Host "KING CLUB libmpv runtime ready: $(Join-Path $targetDirectory 'libmpv-2.dll')"
& $targetExecutable --version | Select-Object -First 4
