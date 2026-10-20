# Packs the source for the VPS into manara-release.tar.gz next to the repo (no node_modules,
# builds, local databases, secrets or test credentials). The server builds the images itself.
# Usage (PowerShell, from anywhere):  powershell -File deploy\vps\make-release.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$out = Join-Path (Split-Path $root -Parent) 'manara-release.tar.gz'

$exclude = @(
  'node_modules', 'dist', '.next', 'out', 'dev', 'legacy', 'backups', '.mascot-voice-stage',
  '.env', '.env.test', '.env.test2', '.env.test3', '.seed-credentials.txt',
  '*.dump', '*.dump.enc', '*.anchor.txt', '*.log', '*.tsbuildinfo'
)
$tarArgs = @('-czf', $out, '-C', $root)
foreach ($e in $exclude) { $tarArgs += "--exclude=$e" }
$tarArgs += '.'

& tar.exe @tarArgs
if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
# Secrets must never leave this machine: stop if one slipped in.
$listing = & tar.exe -tzf $out
if ($listing -match '(^|/)\.env$' -or $listing -match '\.seed-credentials\.txt$') {
  Remove-Item $out
  throw 'A secret file was packed; release removed.'
}

$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Release: $out ($size MB)"
Write-Host "Upload:  scp `"$out`" root@<VPS-IP>:/opt/"
