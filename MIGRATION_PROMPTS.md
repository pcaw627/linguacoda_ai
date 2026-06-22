# LinguaCoda — Migration Prompts

Copy-paste prompts for implementing the **Electron-first** production migration described in [ARCHITECTURE.md](./ARCHITECTURE.md). Run them **in order** within each phase; do not skip ahead until the verification criteria pass.

> **Architecture note:** The Electron desktop app is the **only end-user client**. Vercel hosts a **slim cloud API** (auth, vocab, compute tokens) — not the subtitles/vocab UI. WASAPI loopback capture stays in Electron. Do **not** port `renderer.js` to a browser app.

## How to use these prompts

1. **Read** [ARCHITECTURE.md](./ARCHITECTURE.md) once before starting.
2. **Run one prompt at a time** in Cursor Agent mode (or equivalent).
3. **Verify** the checkpoint at the end of each prompt before moving on.
4. **Provide context** when a prompt says "assume X is done" — paste the previous prompt's outcome or file paths if the agent lacks session memory.
5. **Preserve local mode:** `computeMode: local` must keep today's behavior until remote mode is explicitly enabled.

### Conventions

| Path | Purpose |
|------|---------|
| Repo root (`main.js`, `renderer.js`, …) | Electron desktop app — primary client |
| `services/cloud-api/` | Minimal Next.js API deployed to Vercel |
| `services/compute_gateway/` | Python AI gateway on home PC |
| `transcription_server.py`, `electron_backend.py` | Existing — extend, don't replace |

### Environment variables reference

| Variable | Where | Phase |
|----------|-------|-------|
| `DATABASE_URL` | Vercel + `services/cloud-api/.env.local` | 1 |
| `AUTH_SECRET` | Vercel + local | 1 |
| `GOOGLE_CLIENT_ID` | Vercel + local | 1 |
| `GOOGLE_CLIENT_SECRET` | Vercel + local | 1 |
| `AUTH_URL` | Vercel production | 1 |
| `JWT_SECRET` | Vercel + home PC gateway | 2 |
| `COMPUTE_GATEWAY_URL` | Vercel (server-only, optional health ping) | 2 |
| `LINGUACODA_REMOTE_MODE` | Home PC gateway | 2 |
| `cloudApiBaseUrl` | `electron-config.json` | 1 |
| `computeMode` | `electron-config.json` (`local` \| `remote`) | 2 |
| `computeGatewayUrl` | `electron-config.json` | 2 |

---

## Phase 0 — Repo prep

### Prompt 0.1 — Scaffold slim cloud API

```
Scaffold a minimal Next.js App Router API app at services/cloud-api/ for Vercel deployment. This is NOT a web UI — API routes and OAuth callbacks only.

Requirements:
- Use TypeScript, ESLint, src/ directory, import alias @/*
- Do NOT move or delete existing Electron files (main.js, renderer.js, preload.js, index.html, etc.)
- services/cloud-api/package.json with scripts: dev, build, start, lint
- Minimal src/app/page.tsx: static page with app name + "Desktop app required" message and optional download link placeholder — no vocab grid, no subtitles UI
- Update root .gitignore for services/cloud-api/node_modules, .next, .env.local
- services/cloud-api/README.md: explains this is the Vercel-deployed cloud API (auth + vocab + tokens), not the product UI

Do not copy renderer.js, styles.css, or hsk_dictionary.json to the cloud API (Electron keeps those).

Verification:
- cd services/cloud-api && npm run dev serves localhost:3000
- npm start at repo root still launches Electron unchanged
```

### Prompt 0.2 — Monorepo hygiene

```
Add minimal monorepo documentation without restructuring the Electron app.

Requirements:
- Add a "Repository layout" section to the root README.md (or create one if missing):
  - Repo root = Electron desktop app (primary client) + Python AI services
  - services/cloud-api = Vercel cloud API (auth, vocab, compute tokens)
  - services/compute_gateway = home PC AI gateway (Phase 2)
- Add root package.json script "dev:api": "npm run dev --prefix services/cloud-api" if root package.json exists
- Ensure .gitignore covers services/cloud-api/.env.local, .next

Do not change Electron behavior.

Verification:
- git status shows no accidental deletion of Electron files
- dev:api or documented equivalent works
```

---

## Phase 1 — Cloud API + Electron auth & vocab sync

### Prompt 1.1 — Prisma + PostgreSQL schema

```
Set up Prisma with PostgreSQL in services/cloud-api/ for Auth.js and user vocab storage.

Requirements:
- Install prisma and @prisma/client
- prisma/schema.prisma with:
  - Auth.js adapter models: User, Account, Session, VerificationToken
  - UserVocab: userId (PK, FK to User), seenVocab (Json, default {}), updatedAt (DateTime @updatedAt)
- src/lib/prisma.ts singleton (Next.js hot-reload safe)
- services/cloud-api/.env.example: DATABASE_URL, AUTH_SECRET
- README: run npx prisma migrate dev --name init after setting DATABASE_URL

No Electron changes in this prompt.

Verification:
- prisma validate passes
- seenVocab shape matches renderer.js localStorage.seenVocab: { [word: string]: number }
```

### Prompt 1.2 — Auth.js with Google provider

```
Implement Auth.js (NextAuth v5) with Google OAuth in services/cloud-api/.

Requirements:
- next-auth@beta, @auth/prisma-adapter
- src/auth.ts: Google provider + PrismaAdapter, database sessions
- src/app/api/auth/[...nextauth]/route.ts
- Minimal src/app/page.tsx: Sign in / Sign out for manual OAuth testing in browser (dev only)
- .env.example: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, AUTH_URL

Reference ARCHITECTURE.md Authentication section. No vocab API yet.

Verification:
- npm run build succeeds in services/cloud-api
- /api/auth/signin and /api/auth/callback/google exist
```

### Prompt 1.3 — Vocab API routes

```
Implement authenticated vocab API routes in services/cloud-api/.

Requirements:
- GET /api/vocab:
  - auth() required; 401 if no session
  - Fetch or create UserVocab for session.user.id
  - Response: { seenVocab: Record<string, number>, updatedAt: string }
- PUT /api/vocab:
  - auth() required
  - Body: { seenVocab: Record<string, number> }
  - Per-word max merge: merged[w] = max(existing[w] ?? 0, incoming[w] ?? 0)
  - Upsert, return { seenVocab, updatedAt }
- src/lib/vocab.ts: mergeSeenVocab() helper + types
- Malformed body → 400; payload > 500KB → 413

Match localStorage.seenVocab shape from renderer.js. No Electron changes yet.

Verification:
- TypeScript compiles
- mergeSeenVocab handles conflicting counts correctly
```

### Prompt 1.4 — API token route for Electron (session handoff)

```
Add an API authentication mechanism Electron can use to call /api/vocab without browser cookies.

Requirements:
- POST /api/auth/desktop-token (or /api/auth/electron-token):
  - Accepts a one-time code or exchange token from the desktop OAuth callback flow (design for Prompt 1.6)
  - Returns a long-lived API token (or refresh token) Electron stores in safeStorage
- GET /api/vocab and PUT /api/vocab: accept Authorization: Bearer <api-token> in addition to Auth.js session cookie
- src/lib/api-auth.ts: validateApiToken(), link token to userId
- Prisma model ApiToken: id, userId, tokenHash, expiresAt, createdAt (store hash only, not plaintext)
- .env.example updated

Alternatively use JWT session tokens with refresh — pick one approach and document it in README.

Verification:
- Vocab routes work with Bearer token (curl test)
- Invalid token returns 401
```

### Prompt 1.5 — Vercel deployment config

```
Prepare services/cloud-api/ for Vercel deployment.

Requirements:
- Document in services/cloud-api/README.md:
  - Vercel root directory = services/cloud-api
  - Env vars: DATABASE_URL, AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_URL
  - Google OAuth redirect: https://<domain>/api/auth/callback/google
  - prisma generate in build: "build": "prisma generate && next build"
  - prisma migrate deploy for production
- .env.local gitignored; no secrets committed

Verification:
- npm run build succeeds with DATABASE_URL set
- README has complete Vercel checklist
```

### Prompt 1.6 — Electron Google auth flow

```
Implement Sign in with Google in the Electron app, using the cloud API for OAuth.

Requirements:
- electron-config.json: cloudApiBaseUrl (e.g. https://your-api.vercel.app)
- main.js:
  - Register linguacoda:// protocol handler
  - IPC: sign-in, sign-out, get-auth-status
  - sign-in opens system browser to cloudApiBaseUrl + /api/auth/signin?callbackUrl=...
  - Cloud API callback page /auth/desktop-callback redirects to linguacoda://auth/callback?code=...
  - Exchange code for API token via POST /api/auth/desktop-token; store in safeStorage
- preload.js + electronAPI: signIn(), signOut(), getAuthStatus()
- renderer.js: minimal account UI in menu or settings — show email when signed in, Sign in / Sign out buttons
- Cloud API: implement /auth/desktop-callback page and token exchange from Prompt 1.4

Prefer system browser over embedded WebView. Document manual test steps.

Verification:
- User can sign in via Google from Electron
- safeStorage holds token; restart app still signed in
- Sign out clears token
```

### Prompt 1.7 — Electron cloud vocab sync

```
Add cloud vocab sync to the existing Electron renderer. Keep localStorage as offline draft. Do NOT port UI to web.

Requirements:
- New module: vocab-sync.js (or section in renderer.js) + main.js IPC helpers for authenticated HTTP:
  - cloudApiFetch(path, options) in main process — attaches Bearer token from safeStorage
- electron-config.json: cloudApiBaseUrl (already from 1.6)
- On login / app start (if authenticated):
  - GET cloudApiBaseUrl/api/vocab
  - mergeOnLogin(remote, localStorage draft) — per-word max
  - hydrate seenVocab in renderer
- trackVocabFromText: update memory + localStorage draft; remove blind overwrite of cloud-only state
- Sync triggers:
  - app before-quit / window-close IPC → PUT /api/vocab
  - debounced save every 5 minutes
  - optional "Sync now" not required yet
- When not authenticated or cloudApiBaseUrl unset: behavior identical to today (localStorage only)

Do not change transcription, translation, or capture logic.

Verification:
- Signed-in user: vocab survives app restart
- Two Electron installs with same Google account converge on per-word max counts
- Unsigned / no cloudApiBaseUrl: works offline as before
```

### Prompt 1.8 — Phase 1 health endpoint

```
Add GET /api/health to services/cloud-api/ and a dev sync status indicator in Electron.

Requirements:
- GET /api/health → { ok: true, db: "connected" } with simple prisma query
- Electron settings/account area: show last vocab sync time, cloud API reachability (optional IPC ping /api/health)
- Hide dev details from casual users — small status text is enough

Verification:
- /api/health returns 200 when DB connected
- Electron shows signed-in email + last sync timestamp after vocab save
```

---

## Phase 2 — Compute gateway + Electron remote mode

### Prompt 2.1 — Compute gateway (local mode)

```
Implement Python Compute Gateway at services/compute_gateway/ unifying transcription server and Ollama access.

Requirements:
- Entry: services/compute_gateway/main.py
- Local mode (default): bind 127.0.0.1:8080, no JWT
- Endpoints:
  - GET /health — transcription_server /health + Ollama status
  - POST /transcribe — proxy to 127.0.0.1:8765/transcribe with .transcription_server.token Bearer
  - POST /align — proxy to /align
  - POST /translate — Ollama /api/generate, same prompt as main.js translate-text (electron-config.json)
  - POST /vocab-context, POST /flashcard-entry — Ollama, same prompts as main.js handlers
- services/compute_gateway/requirements.txt if needed
- CLI: python -m services.compute_gateway.main [--port 8080]

No --remote yet. Transcription server stays loopback-only.

Verification:
- curl localhost:8080/health ok with transcription_server + Ollama running
- POST /translate returns translation for test Chinese string
```

### Prompt 2.2 — Gateway remote mode + JWT + rate limiting

```
Add --remote mode to Compute Gateway with JWT validation and rate limiting.

Requirements:
- --remote or LINGUACODA_REMOTE_MODE=1:
  - Authorization: Bearer <JWT> required on all endpoints except GET /health (document if health is public)
  - Validate JWT_SECRET (HS256), check exp
  - Rate limit per JWT sub: 60 req/min → 429 + Retry-After
  - Max body 5 MB on /transcribe → 413
- Local mode unchanged
- services/compute_gateway/README.md documents env vars
- CORS optional (Electron main process is not a browser CORS client) — skip CORS unless you add a web health dashboard later

Reference ARCHITECTURE.md Security section.

Verification:
- Local mode: no token needed
- Remote mode: 401 without token, 200 with valid JWT
```

### Prompt 2.3 — Gateway concurrency limits

```
Add ASR and Ollama concurrency limits to the Compute Gateway.

Requirements:
- MAX_CONCURRENT_TRANSCRIPTIONS (default 2) → 429 when exceeded
- MAX_CONCURRENT_OLLAMA (default 1) for translate / vocab-context / flashcard-entry
- GET /health includes: transcribeActive, transcribeQueued, ollamaActive

Verification:
- Third concurrent /transcribe gets 429 when limit is 2
- health reports concurrency stats
```

### Prompt 2.4 — Cloud API compute token route

```
Add compute token issuance to services/cloud-api/ for Electron to call the home gateway.

Requirements:
- POST /api/compute/token:
  - Requires Electron API token (Bearer from Prompt 1.4) OR Auth.js session
  - Signs JWT: { sub: userId, email, iat, exp } — 15 min TTL, HS256, JWT_SECRET
  - Returns { token, expiresAt }
- Optional GET /api/health/compute: server-side ping to COMPUTE_GATEWAY_URL, returns { online, details } without exposing URL
- .env.example: JWT_SECRET, COMPUTE_GATEWAY_URL

JWT_SECRET must match home PC gateway.

Verification:
- Unauthenticated → 401
- Valid Electron API token → returns JWT
- JWT validates on gateway in remote mode
```

### Prompt 2.5 — Electron compute client (main process)

```
Create an Electron compute client in main.js for remote AI calls. Renderer unchanged for IPC surface.

Requirements:
- lib/compute-client.js (or section in main.js):
  - getComputeToken(): POST cloudApiBaseUrl/api/compute/token with API token
  - cache token until near expiry
  - transcribe(audioBase64, language), translate(text), align(transcription, translation)
  - POST to computeGatewayUrl with Authorization Bearer compute JWT
  - handle 401 (refresh token), 429 (backoff), 503 (warming up)
- electron-config.json:
  - computeMode: "local" | "remote" (default "local")
  - computeGatewayUrl (required when remote)

No IPC changes to renderer yet — next prompt wires handlers.

Verification:
- Unit-style test or manual script can call gateway through compute-client with valid JWT
```

### Prompt 2.6 — Electron remote mode routing

```
Wire Electron IPC handlers to use compute-client when computeMode is "remote", keeping local fallback.

Requirements:
- main.js:
  - translate-text: remote → compute-client.translate; local → existing Ollama axios call
  - extract-semantic-units: remote → compute-client.align; local → existing 127.0.0.1:8765/align
  - generate-vocab-context, get-flashcard-entry: remote → gateway; local → existing Ollama
- electron_backend.py OR transcription_client.py:
  - When computeMode remote (read from config/env passed at spawn): POST transcribe to computeGatewayUrl instead of 127.0.0.1:8765
  - Pass compute JWT via env var set by main before backend spawn, or proxy transcribe through main process IPC
  - Local mode: unchanged — direct to local transcription_server
- WASAPI capture stays in electron_backend.py on the client machine in BOTH modes

Prefer smallest change that works. Document how JWT reaches Python backend.

Verification:
- computeMode local: identical behavior to pre-migration
- computeMode remote: full subtitle pipeline works against gateway on another machine
- Loopback audio capture still works in remote mode
```

### Prompt 2.7 — Cloudflare Tunnel + startup scripts

```
Add Cloudflare Tunnel documentation and Windows startup scripts for the home compute stack.

Requirements:
- services/compute_gateway/README.md:
  - cloudflared install, tunnel → localhost:8080
  - example: compute.yourdomain.com
  - remote mode env vars
- scripts/start_compute_stack.ps1:
  - Check/start transcription_server.py, Ollama, gateway --remote
  - Reminder to run cloudflared
- .env.example: JWT_SECRET, LINGUACODA_REMOTE_MODE, MAX_CONCURRENT_TRANSCRIPTIONS, OLLAMA_ENDPOINT

No secrets committed.

Verification:
- README is copy-paste complete
- Script has no PowerShell syntax errors
```

### Prompt 2.8 — Electron compute status UI

```
Add compute server status to the Electron UI.

Requirements:
- renderer.js + IPC:
  - get-compute-status → main checks local /health or remote gateway /health (with token)
  - Banner or status chip: "Compute: ready" / "warming up" / "offline"
  - When remote and offline: disable Start Capture with clear message; vocab still works
- Show computeMode (local/remote) in settings

Small UI change only.

Verification:
- Local mode: status reflects transcription server ready state
- Remote mode: offline gateway shows banner and blocks capture start
```

---

## Phase 3 — Polish & distribution

### Prompt 3.1 — Settings UI

```
Add a Settings view to the Electron app for account and compute configuration.

Requirements:
- New settings panel or modal in renderer.js:
  - Account: email, Sign in / Sign out, last vocab sync time
  - Compute: mode toggle local/remote (reads/writes electron-config.json via IPC), gateway URL field
  - Cloud API base URL (advanced, default from config)
- main.js IPC: get-settings, save-settings (validate URLs)
- Restart may be required for compute mode change — show notice

Match existing app styling from styles.css.

Verification:
- User can switch computeMode and save
- Account section reflects auth state from Prompt 1.6
```

### Prompt 3.2 — Offline and error UX

```
Improve offline and error handling across Electron for cloud and compute failures.

Requirements:
- renderer.js:
  - Cloud API unreachable: vocab uses local draft, non-blocking toast "Vocab saved locally"
  - Compute 429: show retry message, don't crash capture loop
  - Ollama/gateway timeout: show pair with transcription only (existing pattern)
  - Re-login prompt when API token expired (401 on vocab sync)
- main.js: consistent error shapes from compute-client → IPC

Reference ARCHITECTURE.md Error Handling table.

Verification:
- Airplane mode: app usable, vocab in localStorage draft
- Invalid API token: user prompted to sign in again
```

### Prompt 3.3 — Desktop OAuth callback hardening

```
Harden the Electron OAuth and token flow for production.

Requirements:
- One-time codes expire in 5 minutes
- ApiToken rotation on sign-in (invalidate old tokens)
- linguacoda:// handler validates state param to prevent CSRF
- Cloud API /auth/desktop-callback: clear user-facing success/error pages
- Document Google OAuth redirect URIs needed for production domain

Verification:
- Replayed callback code fails
- Sign in on second machine doesn't invalidate first unless designed to
```

### Prompt 3.4 — Distribution docs (optional installer)

```
Document Electron app distribution; optional electron-builder scaffold.

Requirements:
- README or DISTRIBUTION.md:
  - How end users install the desktop app
  - Required: Python, Ollama, transcription models (link existing setup docs)
  - cloudApiBaseUrl baked in or set on first run
- Optional: electron-builder config stub in package.json — do not publish yet
- Vercel cloud API deployment remains separate from desktop installer

Verification:
- New developer can follow docs to run desktop + pointed cloud API
```

---

## Phase 4 — Hardening

### Prompt 4.1 — Structured logging (gateway + cloud API)

```
Add structured logging to Compute Gateway and cloud API.

Requirements:
- Gateway logs: timestamp, endpoint, userId (JWT sub), duration_ms, status
- Cloud API: log vocab PUT size, auth failures (no tokens in logs)
- Standard error JSON: { error, code?, retryAfterSeconds? }
- Electron compute-client: map errors to user-facing strings in IPC responses

Verification:
- Failed remote transcribe produces one structured log line with userId
```

### Prompt 4.2 — Production safety guards

```
Add production safety guards to services/cloud-api/.

Requirements:
- /api/compute/token rate limit: 10/min per user
- Vocab PUT validation: numeric values only, max 500KB
- /api/health public; all other routes authenticated
- Dev test page 404 in production unless ENABLE_DEV_PAGES=true

Verification:
- Oversized vocab payload → 413 or 400
- Token endpoint rate limited
```

### Prompt 4.3 — ARCHITECTURE.md sync check

```
Review codebase against ARCHITECTURE.md and update ARCHITECTURE.md only where implementation diverged.

Requirements:
- Compare routes, env vars, paths, data models to ARCHITECTURE.md
- Surgical updates + "Implementation status" table at top of ARCHITECTURE.md
- Remove any stale references to apps/web or browser UI port

Verification:
- ARCHITECTURE.md matches repo
```

### Prompt 4.4 — Load test script (manual)

```
Create manual load test for concurrent Electron sessions against remote gateway.

Requirements:
- scripts/load_test_compute.py:
  - --url, --jwt, --sessions N, --duration
  - Concurrent POST /transcribe (or /health)
  - Report: success, 429 count, avg latency
- Document in services/compute_gateway/README.md

Do not add to CI.

Verification:
- --help works
- 3 sessions with limit 2 reports 429s
```

---

## Optional follow-up prompts

Use after core migration is complete.

### Optional A — Read-only vocab dashboard on Vercel

```
Add an optional read-only web page to services/cloud-api showing vocab stats for signed-in users.

Requirements:
- /dashboard route: total words seen, per-level breakdown — NOT a replacement for Electron vocab grid
- Auth required
- No audio, no capture, no subtitles

Verify stats match Electron for same account.
```

### Optional B — electron-builder installer

```
Add electron-builder for Windows installer packaging.

Requirements:
- package.json build config, icons, NSIS or portable
- Bundle or document Python backend dependency
- Do not bundle Ollama models

Verify installer launches app on clean Windows VM.
```

### Optional C — Vercel custom domain

```
Document custom domain for cloud API.

Requirements:
- services/cloud-api/README DNS steps
- Update Google OAuth URIs, AUTH_URL, electron-config cloudApiBaseUrl default
- Update linguacoda:// callback URLs if domain-specific

Verify Electron sign-in works with custom domain.
```

### Optional D — WebSocket streaming (gateway)

```
Add optional WebSocket /stream on gateway for lower-latency transcription.

Requirements:
- JWT on connect
- Electron compute-client uses WS in remote mode, REST fallback
- Local mode unchanged

Verify remote mode session latency improves.
```

---

## Phase completion checklist

| Phase | Done when |
|-------|-----------|
| **0** | `services/cloud-api` runs; Electron unchanged |
| **1** | Google login in Electron; vocab syncs across desktop installs via cloud API |
| **2** | Remote computeMode works through tunnel; local mode unchanged; WASAPI capture on client |
| **3** | Settings UI, offline UX, distribution docs |
| **4** | Logging, guards, docs match code |

---

## What NOT to build

| Do not | Reason |
|--------|--------|
| Port subtitles UI to Next.js | Electron is the only client; WASAPI requires desktop |
| Port vocab grid to Vercel | Same |
| Browser getUserMedia capture | Inferior to WASAPI loopback; multi-browser burden |
| Expose transcription_server.py directly | Use compute gateway |
| Sync pinyinCache / flashcardEntryCache to DB | Regenerable; keep localStorage |

---

## Tips for effective prompting

- **Attach files**: `@ARCHITECTURE.md`, `@renderer.js`, `@main.js`, `@electron_backend.py`, `@transcription_client.py` for Electron and remote routing work.
- **Scope control**: "Only implement Prompt 1.7; do not touch compute gateway."
- **Preserve local mode**: Every Phase 2 prompt should leave `computeMode: local` behavior identical to main-branch today.
- **WASAPI first**: If a change would move audio capture off the client machine, reject it — only ASR/LLM compute moves to the gateway in remote mode.
