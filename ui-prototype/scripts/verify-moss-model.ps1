param(
  [string]$ModelDirectory = "D:\AI-Models\MOSS-Music-8B-Thinking"
)

$ErrorActionPreference = "Stop"
$expected = @(
  @{ Name = "model-00001-of-00004.safetensors"; Length = 4931219872; Sha256 = "dedca5712d284e975d18fbb16b31cfcd0ab3668f5730fe80ff91c7160c5df6b9" },
  @{ Name = "model-00002-of-00004.safetensors"; Length = 4983069688; Sha256 = "a206f2be2b52dc2277c0e7a990b9cfd1acb124ea0b3546e0e65fd3e27d9e4a66" },
  @{ Name = "model-00003-of-00004.safetensors"; Length = 4999847576; Sha256 = "2432da43843911aa45f79e6f38c5c2e297709069a9e9d265daa05b24b975c778" },
  @{ Name = "model-00004-of-00004.safetensors"; Length = 3190899504; Sha256 = "7ae11dca45f34388961f7430685a4b282b62627604318cb90aafe5182bf6d509" }
)

foreach ($item in $expected) {
  $path = Join-Path $ModelDirectory $item.Name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing MOSS-Music model shard: $path"
  }
  $file = Get-Item -LiteralPath $path
  if ($file.Length -ne $item.Length) {
    throw "Unexpected size for $($item.Name): $($file.Length), expected $($item.Length)"
  }
  $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $item.Sha256) {
    throw "SHA-256 mismatch for $($item.Name)"
  }
  Write-Host "Verified $($item.Name) ($($file.Length) bytes)"
}

Write-Host "MOSS-Music-8B-Thinking model verification passed."
