param(
    [Parameter(Mandatory = $true)][ValidateSet('ja', 'en')][string]$Language,
    [switch]$Stop
)

$model = if ($Language -eq 'ja') { 'hy-mt2:7b-q6_k' } else { 'hy-mt2-fixed:1.8b-q8_0' }
$baseUrl = if ([string]::IsNullOrWhiteSpace($env:OLLAMA_BASE_URL)) {
    'http://127.0.0.1:11434'
} else {
    $env:OLLAMA_BASE_URL.TrimEnd('/')
}

try {
    $baseUri = [Uri]$baseUrl
} catch {
    throw "Invalid OLLAMA_BASE_URL: $baseUrl"
}
if ($baseUri.Scheme -ne 'http' -or $baseUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
    throw "OLLAMA_BASE_URL must point to local Ollama (127.0.0.1, localhost, or ::1): $baseUrl"
}

function Invoke-LocalOllama {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()][hashtable]$Body
    )

    try {
        if ($null -eq $Body) {
            return Invoke-RestMethod -Uri "$baseUrl$Path" -Method Get -TimeoutSec 5
        }
        $json = $Body | ConvertTo-Json -Compress
        return Invoke-RestMethod -Uri "$baseUrl$Path" -Method Post `
            -ContentType 'application/json' -Body $json -TimeoutSec 120
    } catch {
        throw "Ollama is not reachable at $baseUrl. Start Ollama first or set OLLAMA_BASE_URL. $($_.Exception.Message)"
    }
}

$tags = Invoke-LocalOllama -Path '/api/tags' -Body $null
$installedModels = @($tags.models | ForEach-Object { $_.name; $_.model } | Where-Object { $_ })
if ($installedModels -notcontains $model) {
    throw "Required model is not installed: $model. No model download was attempted."
}

if ($Stop) {
    $running = Invoke-LocalOllama -Path '/api/ps' -Body $null
    $loaded = @($running.models | Where-Object { $_.name -eq $model -or $_.model -eq $model })
    if (-not $loaded) {
        Write-Output "$model is not loaded."
        return
    }

    $body = @{ model = $model; prompt = ''; stream = $false; keep_alive = 0 }
    Invoke-LocalOllama -Path '/api/generate' -Body $body | Out-Null
    Write-Output "$model is unloaded."
    return
}

$body = @{ model = $model; prompt = ''; stream = $false; keep_alive = '30m' }
Invoke-LocalOllama -Path '/api/generate' -Body $body | Out-Null
Write-Output "$model is loaded and ready at $baseUrl."
