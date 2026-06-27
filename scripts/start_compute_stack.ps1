# Start the full AI compute stack on the SERVER machine (LAN or internet via Cloudflare Tunnel).
# Prerequisites: conda env with requirements.txt, Ollama running, models pulled.

param(
    [switch]$Remote,
    [string]$BindHost = "127.0.0.1",
    [int]$GatewayPort = 8080
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$remoteMode = $Remote -or ($env:LINGUACODA_REMOTE_MODE -eq "1")
if ($remoteMode -and -not $env:JWT_SECRET) {
    Write-Host '[!!] JWT_SECRET is not set - remote mode requires a shared secret matching Vercel.' -ForegroundColor Yellow
    Write-Host "     Example: `$env:JWT_SECRET = 'your-shared-secret'" -ForegroundColor DarkGray
}

Write-Host "=== LinguaCoda Compute Stack ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"

# Gateway imports PyJWT even in local mode - ensure deps are present in active Python env
python -c "import jwt" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[..] Installing compute gateway Python dependencies (PyJWT)..." -ForegroundColor Yellow
    python -m pip install -r "$RepoRoot\services\compute_gateway\requirements.txt"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install services/compute_gateway/requirements.txt"
    }
}

if ($remoteMode) {
    Write-Host "Mode: REMOTE (JWT required on POST)" -ForegroundColor Yellow
} else {
    Write-Host "Mode: LOCAL (trusted LAN, no JWT)" -ForegroundColor Green
    if ($BindHost -eq "127.0.0.1") {
        $BindHost = "0.0.0.0"
    }
}

# Check Ollama
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -UseBasicParsing
    Write-Host "[OK] Ollama is running on :11434" -ForegroundColor Green
} catch {
    Write-Host '[!!] Ollama not reachable at http://127.0.0.1:11434 - run: ollama serve' -ForegroundColor Yellow
}

# Check if transcription server already up
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2 -UseBasicParsing
    Write-Host "[OK] Transcription server already on :8765" -ForegroundColor Green
} catch {
    Write-Host "[..] Starting transcription server on 127.0.0.1:8765 ..." -ForegroundColor Yellow
    Start-Process -FilePath "python" -ArgumentList "transcription_server.py" -WorkingDirectory $RepoRoot -WindowStyle Normal
    Start-Sleep -Seconds 3
}

Write-Host "[..] Starting compute gateway on ${BindHost}:${GatewayPort} ..." -ForegroundColor Yellow
Write-Host ""
if ($remoteMode) {
    Write-Host "Internet access:" -ForegroundColor Cyan
    Write-Host "  1. Bind gateway to loopback (default 127.0.0.1:8080)"
    Write-Host "  2. Run Cloudflare Tunnel: cloudflared tunnel --url http://127.0.0.1:8080"
    Write-Host "  3. Set electron-config.json computeGatewayUrl to your HTTPS tunnel URL"
    Write-Host "  4. Set matching JWT_SECRET on Vercel and this machine"
    Write-Host ""
} else {
    Write-Host "LAN clients should set in electron-config.json:" -ForegroundColor Cyan
    Write-Host '  "computeMode": "remote"'
    Write-Host ('  "computeGatewayUrl": "http://<THIS_MACHINE_LAN_IP>:' + $GatewayPort + '"')
    Write-Host ""
}
Write-Host 'Press Ctrl+C to stop the gateway (transcription server window stays open).' -ForegroundColor DarkGray

$gatewayArgs = @("-m", "services.compute_gateway.main", "--bind", $BindHost, "--port", "$GatewayPort")
if ($remoteMode) {
    $gatewayArgs += "--remote"
}

python @gatewayArgs
