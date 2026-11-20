# Build the NetEase Cloud Music layer as the installer ships it.
#
# The layer is Python, standard library only (`netease_layer/`). A player has no Python of their own,
# so the interpreter travels with it: an embeddable CPython's `python/` folder, with the layer's own
# code inside it — that is what lets `-m netease_layer` find the code with no PYTHONPATH
# (`crates/host/src/netease_layer.rs` explains and looks for exactly this shape).
#
# QQ Music's layer ships the same kind of runtime (`tools/scripts/build-qq-layer.ps1`), so this one is
# seeded from it rather than downloading another: only what the layer imports is copied over.
#
#     pwsh -File tools/scripts/build-netease-layer.ps1
#
# Result: `netease-layer/` beside the sources, ~19 MB, which the installer carries as
# `netease-layer/` (`app/tauri.conf.json`).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sources = Join-Path $root 'netease_layer'
$output = Join-Path $root 'netease-layer'
$staged = Join-Path $output 'python'
# QQ Music's layer carries an embeddable CPython; this one is seeded from it. Both places it can be
# are tried: the staged copy in the source tree, and an installed WestPlay beside it.
$seeds = @(
    (Join-Path $root 'app\qq-music-layer\python'),
    (Join-Path $root '..\WestPlay\qq-music-layer\python'),
    'D:\WestPlay\qq-music-layer\python',
    (Join-Path $env:LOCALAPPDATA 'WestPlay\qq-music-layer\python')
)
if (-not (Test-Path $sources)) {
    throw "The layer's sources are missing: $sources"
}
$seed = $seeds | Where-Object { Test-Path (Join-Path $_ 'python.exe') } | Select-Object -First 1
if (-not $seed) {
    throw ("No interpreter to seed from (looked in: " + ($seeds -join '; ') + ")")
}

Write-Host "WestPlay's NetEase Cloud Music layer" -ForegroundColor Cyan
Write-Host "  sources  $sources"
Write-Host "  output   $output"

if (Test-Path $output) { Remove-Item $output -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $staged 'netease_layer') -Force | Out-Null

# The interpreter: the pieces this layer imports, and nothing else.
#   socket/ssl      -> _socket, _ssl, libssl, libcrypto
#   hashlib         -> _hashlib
#   http.server     -> in python312.zip
#   unicodedata     -> unicodedata.pyd
# Everything else is third-party size (`_decimal`, `_sqlite3`, `Lib/`, ...) a layer with no
# dependencies has no use for.
$files = @(
    'python.exe', 'pythonw.exe', 'python3.dll', 'python312.dll', 'python312.zip', 'python312._pth',
    'vcruntime140.dll', 'vcruntime140_1.dll', 'libffi-8.dll', 'libssl-3.dll', 'libcrypto-3.dll',
    '_socket.pyd', '_ssl.pyd', '_hashlib.pyd', 'unicodedata.pyd', 'select.pyd',
    'LICENSE.txt'
)
foreach ($name in $files) {
    $from = Join-Path $seed $name
    if (-not (Test-Path $from)) { throw "Missing from the seed interpreter: $name" }
    Copy-Item $from (Join-Path $staged $name)
}

# The layer's code, inside the runtime's folder (see above).
Copy-Item (Join-Path $sources '*.py') (Join-Path $staged 'netease_layer')
Copy-Item (Join-Path $sources 'tests') (Join-Path $staged 'netease_layer\tests') -Recurse
Get-ChildItem (Join-Path $staged 'netease_layer') -Recurse -Directory -Filter '__pycache__' |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# It must answer on its own, or the installer would ship a layer that never starts.
Write-Host "  checking it starts..." -ForegroundColor Yellow
$state = Join-Path $env:TEMP ("westplay-netease-" + [guid]::NewGuid().ToString('n'))
$process = Start-Process -FilePath (Join-Path $staged 'python.exe') `
    -ArgumentList '-m', 'netease_layer', '--port', '8797', '--state', $state `
    -WorkingDirectory $staged -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'westplay-netease.out') `
    -RedirectStandardError (Join-Path $env:TEMP 'westplay-netease.err')
Start-Sleep -Seconds 5
$answered = $false
try {
    $answer = Invoke-RestMethod -Uri 'http://127.0.0.1:8797/api/health' -TimeoutSec 5
    $answered = $answer.ok -eq $true
} catch { $answered = $false }
if (-not $process.HasExited) { $process.Kill() }
Remove-Item $state -Recurse -Force -ErrorAction SilentlyContinue
if (-not $answered) {
    Get-Content (Join-Path $env:TEMP 'westplay-netease.err') -ErrorAction SilentlyContinue |
        Select-Object -First 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "The layer didn't answer on /api/health"
}

$size = (Get-ChildItem $output -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("  done: {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Green
