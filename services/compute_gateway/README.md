# Compute Gateway

HTTP entry point for **AI workloads** on the server machine. Desktop clients in `computeMode: "remote"` send transcription, translation, and alignment requests here instead of running models locally.

## Prerequisites (server machine only)

- Python env with repo `requirements.txt` + `install_pkuseg.ps1`
- Ollama running (`ollama serve`) with the model from `electron-config.json`
- Transcription server on loopback `127.0.0.1:8765`
- `pip install -r services/compute_gateway/requirements.txt` (`requests`, `PyJWT`)

## Start the full compute stack

From repo root (PowerShell):

```powershell
conda activate livesub

# LAN dev — no JWT (trusted network)
.\scripts\start_compute_stack.ps1

# Internet / Cloudflare Tunnel — JWT required
$env:JWT_SECRET = "same-secret-as-vercel"
$env:LINGUACODA_REMOTE_MODE = "1"
.\scripts\start_compute_stack.ps1 -Remote
```

Legacy script (LAN only, no `--remote` flag):

```powershell
.\scripts\start_compute_server.ps1
```

Or manually:

```powershell
# Terminal 1 — transcription + models (loopback only)
python transcription_server.py

# Terminal 2 — gateway
python -m services.compute_gateway.main --bind 0.0.0.0 --port 8080

# Remote mode (JWT on POST):
python -m services.compute_gateway.main --remote --bind 127.0.0.1 --port 8080
```

## Fixed ports

| Service | Port | Bind | Who connects |
|---------|------|------|--------------|
| Transcription server | **8765** | 127.0.0.1 | Gateway only |
| Compute gateway | **8080** | 0.0.0.0 (LAN) or 127.0.0.1 (tunnel) | Desktop clients |
| Ollama | **11434** | 127.0.0.1 | Gateway only |
| Cloud API (optional local dev) | **3000** | 127.0.0.1 | Browser / same PC only |

## Health check

```powershell
curl http://127.0.0.1:8080/health
```

`GET /health` is public (no JWT). Response includes `remoteMode`, `transcribeActive`, `ollamaActive`.

## Endpoints

| Method | Path | Proxies to | Auth (remote mode) |
|--------|------|------------|-------------------|
| GET | `/health` | Transcription + Ollama status | None |
| POST | `/transcribe` | `transcription_server:8765/transcribe` | Bearer JWT |
| POST | `/align` | `transcription_server:8765/align` | Bearer JWT |
| POST | `/translate` | Ollama | Bearer JWT |
| POST | `/vocab-context` | Ollama | Bearer JWT |
| POST | `/flashcard-entry` | Ollama | Bearer JWT |

## Remote mode + JWT

Enable with `--remote` or `LINGUACODA_REMOTE_MODE=1`:

- `JWT_SECRET` — HS256 shared secret (must match Vercel `JWT_SECRET`)
- Electron obtains short-lived tokens from `POST /api/compute/token` on the cloud API
- Rate limit: 60 requests/min per JWT `sub` → HTTP 429 + `Retry-After`
- Max body on `/transcribe`: 5 MB → HTTP 413
- Concurrency: `MAX_CONCURRENT_TRANSCRIPTIONS` (default 2), `MAX_CONCURRENT_OLLAMA` (default 1)

## Cloudflare Tunnel (public internet)

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Start gateway in remote mode on loopback:

   ```powershell
   $env:JWT_SECRET = "your-shared-secret"
   python -m services.compute_gateway.main --remote --bind 127.0.0.1 --port 8080
   ```

3. Expose via tunnel:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8080
   ```

   Or use a named tunnel + DNS (e.g. `compute.yourdomain.com`).

4. On Vercel, set `JWT_SECRET` (same value) and optional `COMPUTE_GATEWAY_URL` for `GET /api/health/compute`.

5. On the laptop, set `electron-config.json`:

   ```json
   {
     "computeMode": "remote",
     "computeGatewayUrl": "https://compute.yourdomain.com"
   }
   ```

6. Sign in with Google in the desktop app so it can fetch compute JWTs.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | Required in remote mode |
| `LINGUACODA_REMOTE_MODE` | off | `1` enables JWT requirement |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `2` | ASR concurrency cap |
| `MAX_CONCURRENT_OLLAMA` | `1` | Ollama concurrency cap |
| `COMPUTE_RATE_LIMIT_PER_MIN` | `60` | Per-user rate limit |
| `OLLAMA_ENDPOINT` | from `electron-config.json` | Ollama base URL |
| `OLLAMA_MODEL` | from `electron-config.json` | Model name |
| `TRANSCRIPTION_SERVER_URL` | `http://127.0.0.1:8765` | Loopback ASR server |
