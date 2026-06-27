# Start the AI compute stack on the SERVER machine.
# Prerequisites: conda env with requirements.txt, Ollama running, models pulled.

param(
    [string]$BindHost = "0.0.0.0",
    [int]$GatewayPort = 8080
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=== LinguaCoda Compute Server ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"

python -c "import jwt" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[..] Installing compute gateway Python dependencies (PyJWT)..." -ForegroundColor Yellow
    python -m pip install -r "$RepoRoot\services\compute_gateway\requirements.txt"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install services/compute_gateway/requirements.txt"
    }
}

# Check Ollama
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -UseBasicParsing
    Write-Host "[OK] Ollama is running on :11434" -ForegroundColor Green
} catch {
    Write-Host "[!!] Ollama not reachable at http://127.0.0.1:11434 — run: ollama serve" -ForegroundColor Yellow
}

# Check if transcription server already up
$tsRunning = $false
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2 -UseBasicParsing
    $tsRunning = $true
    Write-Host "[OK] Transcription server already on :8765" -ForegroundColor Green
} catch {
    Write-Host "[..] Starting transcription server on 127.0.0.1:8765 ..." -ForegroundColor Yellow
    Start-Process -FilePath "python" -ArgumentList "transcription_server.py" -WorkingDirectory $RepoRoot -WindowStyle Normal
    Start-Sleep -Seconds 3
}

Write-Host "[..] Starting compute gateway on ${BindHost}:${GatewayPort} ..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Clients should set in electron-config.json:" -ForegroundColor Cyan
Write-Host '  "computeMode": "remote"'
Write-Host "  `"computeGatewayUrl`": `"http://<THIS_MACHINE_LAN_IP>:${GatewayPort}`""
Write-Host ""
Write-Host 'Press Ctrl+C to stop the gateway (transcription server window stays open).' -ForegroundColor DarkGray

python -m services.compute_gateway.main --bind $BindHost --port $GatewayPort
