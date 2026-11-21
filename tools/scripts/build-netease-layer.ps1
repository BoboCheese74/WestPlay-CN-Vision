# Build the NetEase Cloud Music layer as the installer ships it.
#
# The layer is Python, standard library only (`netease_layer/`), so this stage is just its sources: an
# embeddable CPython per layer would be eighteen megabytes of the very same files twice, and QQ Music's
# layer already ships one. `crates/host/src/netease_layer.rs` looks for an interpreter beside the layer,
# then beside the other layers' resources, and sets `PYTHONPATH` to wherever the code ended up.
#
#     pwsh -File tools/scripts/build-netease-layer.ps1
#
# Result: `netease-layer/netease_layer/` beside the sources, about 100 KB, which the installer carries as
# `netease-layer/` (`app/tauri.conf.json`).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sources = Join-Path $root 'netease_layer'
$output = Join-Path $root 'netease-layer'
$code = Join-Path $output 'netease_layer'

if (-not (Test-Path $sources)) {
    throw "The layer's sources are missing: $sources"
}

Write-Host "WestPlay's NetEase Cloud Music layer" -ForegroundColor Cyan
Write-Host "  sources  $sources"
Write-Host "  output   $output"

if (Test-Path $output) { Remove-Item $output -Recurse -Force }
New-Item -ItemType Directory -Path $code -Force | Out-Null
Copy-Item (Join-Path $sources '*.py') $code
# The one file that starts it: embedded CPython ignores PYTHONPATH, so this puts the code on sys.path.
Copy-Item (Join-Path $sources '_boot.py') (Join-Path $output '_boot.py')
Copy-Item (Join-Path $sources 'tests') (Join-Path $code 'tests') -Recurse
Get-ChildItem $code -Recurse -Directory -Filter '__pycache__' |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# It must still answer, with the interpreter it will be lent at run time. QQ Music's is used here for
# the same reason the host will: that is the one this layer runs on.
$seeds = @(
    (Join-Path $root 'app\qq-music-layer\python'),
    'D:\WestPlay\qq-music-layer\python',
    (Join-Path $env:LOCALAPPDATA 'WestPlay\qq-music-layer\python')
)
$python = $seeds | Where-Object { Test-Path (Join-Path $_ 'python.exe') } | Select-Object -First 1
if (-not $python) {
    throw ("No interpreter to check with (looked in: " + ($seeds -join '; ') + ")")
}

Write-Host "  checking it starts (with $python)..." -ForegroundColor Yellow
$state = Join-Path $env:TEMP ("westplay-netease-" + [guid]::NewGuid().ToString('n'))
$process = Start-Process -FilePath (Join-Path $python 'python.exe') `
    -ArgumentList (Join-Path $output '_boot.py'), '--port', '8797', '--state', $state `
    -WorkingDirectory $output -PassThru -WindowStyle Hidden `
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
Write-Host ("  done: {0:N0} KB" -f ($size / 1KB)) -ForegroundColor Green
