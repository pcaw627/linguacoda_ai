# Server vs Client Setup

LinguaCoda splits into three tiers. **Do not confuse them:**

| Tier | What it runs | Where | Port |
|------|----------------|-------|------|
| **Cloud API** | Google auth, vocab sync | **Vercel** (recommended) or local dev | 3000 (local only) |
| **Compute server** | SenseVoice, SimAlign, Ollama | **Your server PC** | **8080** (gateway), 8765 (internal) |
| **Desktop client** | UI, WASAPI audio capture | **User laptop** | — |

The laptop **never downloads AI models** when `computeMode` is `"remote"`. Audio is captured locally; transcription/translation HTTP requests go to the server gateway.

---

## Recommended production layout

```
[Laptop]  Electron app
    │  WASAPI capture (local)
    │  audio chunks ──────────────────────► [Server] Compute Gateway :8080
    │  translate / align / flashcards ────►       └► transcription :8765
    │                                              └► Ollama :11434
    │
    │  auth + vocab ──────────────────────► [Vercel] Cloud API
    └  (https://linguacoda-ai.vercel.app)
```

**Cloud API stays on Vercel** for both machines. You do **not** need `npm run dev:api` on the server for normal laptop testing.

---

## Server machine (models only)

### One-time setup

1. Clone repo, checkout `vercel` branch
2. Python env + `pip install -r requirements.txt` + `.\scripts\install_pkuseg.ps1`
3. `ollama serve` and `ollama pull gemma3:4b` (match `electron-config.json`)
4. Windows firewall: allow inbound **TCP 8080** on private network

### Every session

```powershell
cd <repo-root>
conda activate livesub
npm run start:compute-server
```

Or manually:

```powershell
# Window 1
python transcription_server.py

# Window 2
python -m services.compute_gateway.main --bind 0.0.0.0 --port 8080
```

### Verify

```powershell
curl http://127.0.0.1:8080/health
```

From laptop (replace with server LAN IP):

```powershell
curl http://192.168.1.100:8080/health
```

Find server IP: `ipconfig` → IPv4 Address on Wi‑Fi/Ethernet.

---

## Client machine (laptop — no models)

### One-time setup

1. Clone repo (or copy only what you need — still easiest to use full repo)
2. `npm install` at repo root
3. **No** `pip install`, **no** Ollama, **no** SenseVoice on the laptop

### Configure `electron-config.json`

Copy from `electron-config.client.example.json` and set your server IP:

```json
{
  "cloudApiBaseUrl": "https://linguacoda-ai.vercel.app",
  "computeMode": "remote",
  "computeGatewayUrl": "http://192.168.1.100:8080"
}
```

| Field | Client value |
|-------|----------------|
| `computeMode` | `"remote"` |
| `computeGatewayUrl` | `http://<SERVER_LAN_IP>:8080` |
| `cloudApiBaseUrl` | Vercel URL (not localhost) |

### Run

```powershell
npm start
```

Sign in with Google (uses Vercel). Subtitles/capture use the remote gateway.

---

## Ports are fixed — not dynamic

| Service | Port | Notes |
|---------|------|--------|
| Compute gateway | **8080** | Set in `computeGatewayUrl` on client |
| Transcription (internal) | **8765** | Server loopback only |
| Ollama (internal) | **11434** | Server loopback only |
| Cloud API local dev | **3000** | Pinned; see below |

If `npm run dev:api` says port 3000 is in use, **free port 3000** — do not use 3001 and expect the client to find it:

```powershell
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

---

## `npm run dev:api` — when to use

**Only for developing the cloud API itself** (auth, vocab routes) on the same PC as your browser.

- Runs Next.js on **http://localhost:3000** (pinned port)
- **Not** the AI model server
- **Not** what the laptop should point at in production

For laptop + server testing:

- Auth/vocab → **Vercel** (`cloudApiBaseUrl`)
- AI → **server gateway** (`computeGatewayUrl`)

### Local cloud API (same PC only)

If you must test auth against local Next.js:

1. `electron-config.json` → `"cloudApiBaseUrl": "http://localhost:3000"`
2. Google OAuth redirect URI must include `http://localhost:3000/api/auth/callback/google`
3. `services/cloud-api/.env` with `AUTH_URL=http://localhost:3000`

OAuth **cannot** use `http://192.168.x.x:3000` from another machine — use Vercel for cross-device auth.

---

## Windows Firewall — allow TCP 8080 (LAN only)

Use this when the laptop and server are on the **same trusted network** (home Wi‑Fi, office LAN). Restrict the rule to the **Private** profile so coffee-shop / public Wi‑Fi does not expose the port.

### Option A — GUI (recommended first time)

1. Press **Win + R** → type `wf.msc` → **Enter** (Windows Defender Firewall with Advanced Security)
2. Left panel: click **Inbound Rules**
3. Right panel: click **New Rule…**
4. **Rule Type:** Port → **Next**
5. **TCP**, **Specific local ports:** `8080` → **Next**
6. **Allow the connection** → **Next**
7. **Profiles:** check **Private** only; **uncheck** Domain and Public → **Next**
8. **Name:** `LinguaCoda Compute Gateway` → **Finish**

### Option B — PowerShell (run as Administrator)

```powershell
New-NetFirewallRule `
  -DisplayName "LinguaCoda Compute Gateway" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8080 `
  -Action Allow `
  -Profile Private
```

To remove later: `Remove-NetFirewallRule -DisplayName "LinguaCoda Compute Gateway"`

### Verify from laptop

```powershell
curl http://YOUR_SERVER_LAN_IP:8080/health
```

---

## Laptop on a different / public network (secure path)

**Do not** open port 8080 on your home router or bind the gateway to the public internet as plain `http://YOUR_PUBLIC_IP:8080`. That sends audio and AI traffic over **unencrypted HTTP** with **no authentication** (current LAN dev mode).

| Setup | Security | When to use |
|-------|----------|-------------|
| `http://192.168.x.x:8080` + Private firewall rule | Trusted LAN only | Dev, same home Wi‑Fi |
| `http://PUBLIC_IP:8080` port-forward | **Insecure — do not use** | Never |
| **Cloudflare Tunnel** + HTTPS + JWT | Production-safe | Laptop on cellular, other cities, public Wi‑Fi |

### Public internet architecture (Phase 2)

```
[Laptop anywhere]
    │  HTTPS + short-lived JWT
    └──────────────────► https://compute.yourdomain.com  (Cloudflare Tunnel)
                                    └► server 127.0.0.1:8080 (gateway --remote)
```

1. **Cloud API (Vercel)** — issues 15‑minute compute JWTs after Google sign-in (`POST /api/compute/token`). Set `JWT_SECRET` on Vercel (same value as the server).
2. **Cloudflare Tunnel** on the server — exposes `localhost:8080` as `https://compute.yourdomain.com` without opening router ports ([Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).
3. **Gateway `--remote` mode** — requires `Authorization: Bearer <JWT>` on POST endpoints (`.\scripts\start_compute_stack.ps1 -Remote`).
4. **Laptop `electron-config.json`:**
   ```json
   "computeMode": "remote",
   "computeGatewayUrl": "https://compute.yourdomain.com"
   ```
5. **Sign in** in the desktop app so it can fetch compute tokens from Vercel.

### LAN vs public internet

| Feature | LAN (`start_compute_stack.ps1`) | Public internet (`-Remote` + tunnel) |
|---------|--------------------------------|--------------------------------------|
| Google sign-in / vocab | Vercel (any network) | Same |
| Transcription / translate | Same Wi‑Fi, HTTP :8080 | Any network, HTTPS + JWT |
| Encrypted transport | No (LAN trust) | Yes (TLS via Cloudflare) |
| Block strangers from using your GPU | Firewall LAN only | JWT + rate limits |

For LAN testing without JWT, use `.\scripts\start_compute_stack.ps1` (no `-Remote`). For internet access, use `-Remote` and a tunnel — see `services/compute_gateway/README.md`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Client can't reach compute | Check `computeGatewayUrl` IP, firewall, `curl http://SERVER:8080/health` from laptop |
| Client still downloads models | `computeMode` must be `"remote"`; restart app after config change |
| Auth works but no transcription | Gateway/transcription not ready — wait for SenseVoice on server |
| `dev:api` on 3001 | Kill process on :3000; cloud API is pinned to 3000 |
| Confused cloud vs compute | Cloud = Vercel auth/vocab. Compute = :8080 gateway on server |

---

## `computeMode` reference

| Mode | Transcription | Translation | Models on client? |
|------|---------------|-------------|-----------------|
| `local` | `127.0.0.1:8765` | Local Ollama | Yes |
| `remote` | `computeGatewayUrl/transcribe` | Via gateway | **No** |

See also: [services/compute_gateway/README.md](./services/compute_gateway/README.md), [ARCHITECTURE.md](./ARCHITECTURE.md).
