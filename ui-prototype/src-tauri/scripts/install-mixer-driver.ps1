param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ExtractDirectory
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
  throw "Driver archive not found: $ArchivePath"
}

if (Test-Path -LiteralPath $ExtractDirectory) {
  Remove-Item -LiteralPath $ExtractDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ExtractDirectory -Force | Out-Null
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDirectory -Force

$installer = Get-ChildItem -LiteralPath $ExtractDirectory -Recurse -File -Filter '*.exe' |
  Where-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
    $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'Allen\s*&\s*Heath|AllenHeath'
  } |
  Select-Object -First 1

if (-not $installer) {
  throw 'No valid Allen & Heath signed installer was found in the archive.'
}

$process = Start-Process -FilePath $installer.FullName -Verb RunAs -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Driver installer exited with code $($process.ExitCode)."
}
