$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$testRoot = Join-Path $root 'tests\whisper-ja-zh-base'
$python = Join-Path $testRoot '.venv\Scripts\python.exe'

if (-not (Test-Path (Join-Path $testRoot 'model\model.safetensors'))) {
    throw 'The optional direct-translation model is missing.'
}

& $python -m uvicorn server:app --app-dir $testRoot --host 127.0.0.1 --port 8767
