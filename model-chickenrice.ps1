param(
    [Parameter(Mandatory = $true)][ValidateSet('asr', 'translation')][string]$Mode,
    [switch]$Stop
)

$root = $PSScriptRoot
$port = if ($Mode -eq 'asr') { 8770 } else { 8771 }
$modelFolder = if ($Mode -eq 'asr') { 'models\chickenrice-ja-asr' } else { 'models\chickenrice-ja-audio-translation' }
$modelDir = Join-Path $root $modelFolder
$bundle = if ([string]::IsNullOrWhiteSpace($env:CHICKENRICE_RUNTIME_DIR)) {
    Join-Path (Split-Path -Parent $root) 'Faster-Whisper-TransWithAI-ChickenRice\_internal'
} else {
    $env:CHICKENRICE_RUNTIME_DIR
}
$run = Join-Path $root 'run'
$logs = Join-Path $root 'logs'
$pidFile = Join-Path $run "chickenrice-$Mode.pid"

if ($Stop) {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        Write-Output "No managed ChickenRice $Mode service was found."
        return
    }
    $servicePid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
    if ($process -and $process.Name -eq 'python.exe' -and
        $process.CommandLine -like '*chickenrice_server:app*' -and
        $process.CommandLine -like "*--port $port*") {
        Stop-Process -Id $servicePid
        Write-Output "Stopped ChickenRice $Mode (PID $servicePid)."
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    return
}

if (-not (Test-Path -LiteralPath (Join-Path $modelDir 'model.bin'))) {
    throw "ChickenRice model missing: $modelDir"
}
if (-not (Test-Path -LiteralPath $bundle)) {
    throw "AMD/HIP runtime missing: $bundle. Set CHICKENRICE_RUNTIME_DIR to its _internal directory."
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "ChickenRice $Mode port $port is already in use (PID $($listener.OwningProcess))."
    return
}
$python = (& py -3.10 -c 'import sys; print(sys.executable)' | Select-Object -Last 1).Trim()
New-Item -ItemType Directory -Path $run, $logs -Force | Out-Null
$oldPath = $env:PATH
$oldPythonPath = $env:PYTHONPATH
$oldMode = $env:CHICKENRICE_MODE
$oldOffline = $env:HF_HUB_OFFLINE
$oldRocblasPath = $env:ROCBLAS_TENSILE_LIBPATH
try {
    $env:PATH = "$bundle;$bundle\_rocm_sdk_core\bin;$bundle\_rocm_sdk_libraries_custom\bin;$oldPath"
    $env:PYTHONPATH = $bundle
    $env:CHICKENRICE_MODE = $Mode
    $env:HF_HUB_OFFLINE = '1'
    $env:ROCBLAS_TENSILE_LIBPATH = Join-Path $root 'bin\chickenrice-rocblas\library'
    $process = Start-Process -FilePath $python -ArgumentList @(
        '-m', 'uvicorn', 'chickenrice_server:app', '--host', '127.0.0.1', '--port', "$port"
    ) -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logs "chickenrice-$Mode.out.log") `
      -RedirectStandardError (Join-Path $logs "chickenrice-$Mode.err.log") -PassThru
} finally {
    $env:PATH = $oldPath
    $env:PYTHONPATH = $oldPythonPath
    $env:CHICKENRICE_MODE = $oldMode
    $env:HF_HUB_OFFLINE = $oldOffline
    $env:ROCBLAS_TENSILE_LIBPATH = $oldRocblasPath
}
Set-Content -LiteralPath $pidFile -Value $process.Id
for ($attempt = 0; $attempt -lt 180; $attempt++) {
    if ($process.HasExited) { throw "ChickenRice $Mode exited. Check logs\chickenrice-$Mode.err.log" }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
        if ($health.ready -eq $true) {
            Write-Output "ChickenRice $Mode ready on http://127.0.0.1:$port (PID $($process.Id))."
            return
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
throw "ChickenRice $Mode did not become ready. Check logs\chickenrice-$Mode.err.log"
