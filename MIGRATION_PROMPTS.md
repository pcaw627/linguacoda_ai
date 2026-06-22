# LinguaCoda — Migration Prompts

Copy-paste prompts for implementing the production migration described in [ARCHITECTURE.md](./ARCHITECTURE.md). Run them **in order** within each phase; do not skip ahead until the verification criteria pass.

## How to use these prompts

1. **Read** [ARCHITECTURE.md](./ARCHITECTURE.md) once before starting.
2. **Run one prompt at a time** in Cursor Agent mode (or equivalent).
3. **Verify** the checkpoint at the end of each prompt before moving on.
4. **Provide context** when a prompt says "assume X is done" — paste the previous prompt's outcome or file paths if the agent lacks session memory.
5. **Do not break Electron** unless the prompt explicitly says to modify it. The desktop app must keep working until Phase 3.

### Conventions

- Web app root: `apps/web/`
- Existing Electron app: repo root (`main.js`, `renderer.js`, etc.)
- Python AI services: repo root (`transcription_server.py`, etc.)
- New gateway: `services/compute_gateway/`

### Environment variables reference

| Variable | Where | Phase |
|----------|-------|-------|
| `DATABASE_URL` | Vercel + `apps/web/.env.local` | 1 |
| `AUTH_SECRET` | Vercel + local | 1 |
| `GOOGLE_CLIENT_ID` | Vercel + local | 1 |
| `GOOGLE_CLIENT_SECRET` | Vercel + local | 1 |
| `AUTH_URL` | Vercel production | 1 |
| `JWT_SECRET` | Vercel + home PC | 2 |
| `COMPUTE_GATEWAY_URL` | Vercel (server-only) | 2 |
| `ALLOWED_ORIGINS` | Home PC gateway | 2 |
| `LINGUACODA_REMOTE_MODE` | Home PC gateway | 2 |

---

## Phase 0 — Repo prep

### Prompt 0.1 — Scaffold Next.js web app

```
Scaffold a Next.js App Router app at apps/web/ in this repo without breaking the existing Electron app at the repo root.

Requirements:
- Use TypeScript, Tailwind CSS, ESLint, src/ directory, import alias @/*
- Do NOT move or delete existing Electron files (main.js, renderer.js, preload.js, index.html, etc.)
- Add apps/web/package.json with its own scripts (dev, build, start, lint)
- Update root .gitignore to cover apps/web/node_modules, .next, .env.local
- Copy hsk_dictionary.json to apps/web/public/hsk_dictionary.json
- Copy assets/images/ to apps/web/public/assets/images/

Deliverables:
- apps/web/ fully scaffolded
- Brief note in apps/web/README.md explaining this is the Vercel-deployed web client

Verification:
- cd apps/web && npm run dev serves localhost:3000
- npm start at repo root still launches Electron unchanged
```

### Prompt 0.2 — Monorepo hygiene

```
Add minimal monorepo documentation without restructuring the Electron app.

Requirements:
- Add a short "Repository layout" section to the root README.md (or create one if missing) describing:
  - apps/web = Vercel web client (Next.js)
  - repo root = Electron desktop + Python AI services
- Add a root package.json script "dev:web": "npm run dev --prefix apps/web" if a root package.json exists; otherwise document the cd apps/web && npm run dev command
- Ensure .gitignore covers: apps/web/.env.local, apps/web/.next, node_modules in both roots

Do not change Electron behavior. Keep the diff small.

Verification:
- git status shows no accidental deletion of Electron files
- dev:web or documented equivalent works
```

---

## Phase 1 — Auth + vocab cloud

### Prompt 1.1 — Prisma + PostgreSQL schema

```
Set up Prisma with PostgreSQL in apps/web/ for Auth.js and user vocab storage.

Requirements:
- Install prisma and @prisma/client
- Create prisma/schema.prisma with:
  - Auth.js adapter models: User, Account, Session, VerificationToken (standard Auth.js Prisma schema)
  - UserVocab model: userId (PK, FK to User), seenVocab (Json, default {}), updatedAt (DateTime @updatedAt)
- Create src/lib/prisma.ts singleton client (handle Next.js hot reload)
- Add .env.example in apps/web listing DATABASE_URL and AUTH_SECRET
- Document in apps/web/README.md: run `npx prisma migrate dev --name init` after setting DATABASE_URL

Follow existing project conventions. Do not add auth UI yet.

Verification:
- prisma validate passes
- schema includes UserVocab with seenVocab Json field matching { [word: string]: number }
```

### Prompt 1.2 — Auth.js with Google provider

```
Implement Auth.js (NextAuth v5) with Google OAuth in apps/web/.

Requirements:
- Install next-auth@beta and @auth/prisma-adapter
- Create src/auth.ts with Google provider and PrismaAdapter
- Create src/app/api/auth/[...nextauth]/route.ts exporting GET and POST handlers
- Use database sessions (strategy: "database") with the Prisma adapter
- Create a minimal src/app/page.tsx:
  - If signed in: show user email and a Sign out button (server action)
  - If signed out: show Sign in with Google button (server action)
- Add src/middleware.ts only if needed for auth route protection (keep minimal for now)
- Update apps/web/.env.example with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, AUTH_URL

Reference ARCHITECTURE.md Authentication section. Do not implement vocab API yet.

Verification:
- npm run build succeeds in apps/web
- /api/auth/signin and /api/auth/callback/google routes exist
```

### Prompt 1.3 — Vocab API routes

```
Implement authenticated vocab read/write API routes in apps/web/.

Requirements:
- GET /api/vocab (src/app/api/vocab/route.ts):
  - Require auth via auth() from src/auth.ts
  - Return 401 if no session
  - Fetch UserVocab for session.user.id; create empty row if missing
  - Response: { seenVocab: Record<string, number>, updatedAt: string (ISO) }
- PUT /api/vocab:
  - Require auth
  - Body: { seenVocab: Record<string, number> }
  - Merge with per-word max: merged[word] = max(existing[word] ?? 0, incoming[word] ?? 0)
  - Upsert UserVocab, update updatedAt
  - Response: { seenVocab, updatedAt }
- Add src/lib/vocab.ts with mergeSeenVocab(existing, incoming) helper and types
- Handle malformed JSON with 400

Do not build UI yet. Match data shape of localStorage.seenVocab in renderer.js.

Verification:
- TypeScript compiles
- mergeSeenVocab unit logic: max merge works for conflicting counts
```

### Prompt 1.4 — Vocab sync client library

```
Create a client-side vocab sync module for apps/web/ that will back the vocab tracker UI.

Requirements:
- src/lib/vocab-client.ts (or src/hooks/useVocab.ts) with:
  - In-memory seenVocab state
  - loadVocab(): GET /api/vocab when authenticated
  - saveVocab(): PUT /api/vocab with current state
  - trackWord(word) / trackVocabFromText(text, hskWords) — port greedy longest-match logic from renderer.js trackVocabFromText
  - mergeOnLogin(remote, localDraft): per-word max merge
  - Sync triggers:
    - debounced save every 5 minutes during activity
    - save on visibilitychange → hidden
    - save on pagehide via fetch with keepalive: true (and sendBeacon fallback if needed)
  - localStorage key linguacoda_seenVocab_draft as offline draft; clear after successful cloud sync
- Export types and a React hook useVocab() if using hooks

Do not port full UI yet. No transcription features.

Verification:
- Hook/module compiles
- trackVocabFromText logic matches renderer.js behavior for HSK word segmentation
```

### Prompt 1.5 — Port vocab tracker UI

```
Port the HSK Vocab Tracker UI from the Electron app to apps/web/ as an authenticated page.

Requirements:
- New route: src/app/vocab/page.tsx (or /suite with vocab section) — require login, redirect to / if not authenticated
- Port styles from styles.css for vocab tracker (convert to Tailwind or CSS module; preserve GitHub-style grid, level sections, search)
- Load HSK dictionary from /hsk_dictionary.json (same format as electronAPI.getHskDictionary)
- Use pinyin-pro for pinyin display and search (install in apps/web)
- Wire useVocab() hook: load on mount, track counts, sync on triggers from Prompt 1.4
- Port vocab search: normalizePinyin, vocabMatchesSearch from renderer.js
- Show stats: "X / Y words seen" and search match counts
- Menu/landing: update home page to link to Vocab Tracker when signed in

Do NOT port transcription, translation, flashcards, or detail modal yet.
Show a "Subtitles & Translation — coming soon" placeholder nav item.

Reference: renderer.js initializeVocabTracker, renderVocabGrid, setupVocabSearch, and related CSS in styles.css.

Verification:
- Signed-in user sees vocab grid grouped by HSK level 1-6
- Search by pinyin and hanzi works
- seenVocab persists across page refresh
```

### Prompt 1.6 — Vercel deployment config

```
Prepare apps/web/ for Vercel deployment.

Requirements:
- apps/web/vercel.json only if needed (usually not for standard Next.js)
- Document deployment steps in apps/web/README.md:
  - Vercel root directory = apps/web
  - Required env vars: DATABASE_URL, AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_URL
  - Google OAuth redirect URI: https://<vercel-domain>/api/auth/callback/google
  - Run prisma migrate deploy in Vercel build or document manual migration for production
- Add postinstall or build script to run prisma generate (prisma generate in package.json build pipeline)
- For production DB migrations: add "build": "prisma generate && next build" pattern

Do not commit secrets. Ensure .env.local is gitignored.

Verification:
- npm run build succeeds locally with DATABASE_URL set
- README has complete Vercel setup checklist
```

### Prompt 1.7 — Phase 1 integration test page

```
Add a minimal integration test / dev utilities page for Phase 1 verification.

Requirements:
- src/app/dev/sync-test/page.tsx (or /api/health) — auth-protected in production via env check or simple NODE_ENV guard
- Display: last sync time, seenVocab entry count, updatedAt from server
- Buttons: Force sync now, Reset local draft, Show raw JSON
- GET /api/health returns { ok: true, db: "connected" } with a simple prisma query

This helps verify multi-device sync during development. Hide or 404 in production if NEXT_PUBLIC_ENABLE_DEV_PAGES is not set.

Verification:
- Health endpoint works
- Dev page shows vocab state after tracking words
```

---

## Phase 2 — Compute gateway + remote AI

### Prompt 2.1 — Compute gateway (local mode)

```
Implement a Python Compute Gateway at services/compute_gateway/ that unifies access to the existing transcription server and Ollama.

Requirements:
- Entry point: services/compute_gateway/main.py (or compute_gateway.py at repo root if you prefer)
- Local mode (default): bind 127.0.0.1:8080, no JWT required
- Endpoints:
  - GET /health — aggregate status from transcription_server GET /health and Ollama GET /api/tags (or equivalent)
  - POST /transcribe — proxy to http://127.0.0.1:8765/transcribe with Bearer token read from .transcription_server.token
  - POST /align — proxy to /align with same auth
  - POST /translate — call Ollama POST /api/generate using the same prompt and config as main.js translate-text handler (read electron-config.json for ollamaEndpoint and ollamaModel)
- Read transcription token from repo-root .transcription_server.token
- Use stdlib http.server or FastAPI/Flask — match project style (transcription_server uses stdlib; FastAPI is fine if you add requirements)
- Add services/compute_gateway/requirements.txt if new deps needed
- CLI: python -m services.compute_gateway.main [--port 8080]

Do NOT implement --remote, JWT, or CORS yet. Transcription server stays on 127.0.0.1 only.

Verification:
- With transcription_server.py and Ollama running, curl localhost:8080/health returns ok
- POST /transcribe with sample audio payload matches direct server behavior
- POST /translate returns translation for a Chinese test string
```

### Prompt 2.2 — Gateway remote mode + JWT + CORS

```
Add --remote mode to the Compute Gateway with JWT validation, CORS, and basic rate limiting.

Requirements:
- --remote flag or LINGUACODA_REMOTE_MODE=1 env:
  - Require Authorization: Bearer <JWT> on all endpoints except GET /health (health may be public or optionally protected — document choice)
  - Validate JWT with JWT_SECRET env (HS256), check exp claim
  - CORS: allow origins from ALLOWED_ORIGINS env (comma-separated), e.g. https://your-app.vercel.app
  - Rate limit: simple in-memory sliding window per JWT sub — 60 requests/minute (return 429 with Retry-After)
  - Max request body size: 5 MB for transcribe (return 413)
- Local mode (no --remote): unchanged, no JWT
- Document env vars in services/compute_gateway/README.md

Reference ARCHITECTURE.md Security and Concurrency sections.

Verification:
- Local mode still works without token
- Remote mode rejects missing/invalid JWT with 401
- Valid JWT allows transcribe
- CORS preflight from allowed origin succeeds
```

### Prompt 2.3 — Gateway concurrency queue

```
Add ASR concurrency limits to the Compute Gateway.

Requirements:
- MAX_CONCURRENT_TRANSCRIPTIONS env (default 2)
- When /transcribe exceeds limit: return 429 with JSON { error, retryAfterSeconds } or queue with timeout (document behavior — prefer 429 for v1)
- MAX_CONCURRENT_OLLAMA env (default 1) for /translate
- Include queue depth / active jobs in GET /health response: { transcribeActive, transcribeQueued, ollamaActive }

Verification:
- health shows concurrency stats
- third simultaneous transcribe request gets 429 when limit is 2
```

### Prompt 2.4 — Vercel compute token BFF

```
Add server-side compute token issuance to apps/web/.

Requirements:
- POST /api/compute/token (auth required):
  - Validate session via auth()
  - Sign JWT with JWT_SECRET: { sub: userId, email, iat, exp } — 15 minute TTL
  - Return { token, expiresAt }
- GET /api/health/compute (auth required):
  - Server-side fetch to COMPUTE_GATEWAY_URL/health (use server env, not NEXT_PUBLIC)
  - Return { online: boolean, details } — do not expose gateway URL to client
- Update apps/web/.env.example: JWT_SECRET, COMPUTE_GATEWAY_URL
- src/lib/compute-token.ts: getComputeToken() client helper that calls POST /api/compute/token and caches until near expiry

JWT_SECRET must match home PC gateway. COMPUTE_GATEWAY_URL is server-only.

Verification:
- Unauthenticated request to /api/compute/token returns 401
- Authenticated request returns valid JWT
- /api/health/compute returns online:false gracefully when gateway unreachable
```

### Prompt 2.5 — Web compute client

```
Create a browser client for the home Compute Gateway in apps/web/.

Requirements:
- src/lib/compute-client.ts:
  - getAuthHeaders(): fetch token from /api/compute/token, return Authorization header
  - transcribe(audioBase64, language?): POST to COMPUTE_GATEWAY_URL — use NEXT_PUBLIC_COMPUTE_GATEWAY_URL for direct browser calls OR document that client calls gateway directly with public URL
  - translate(text): POST /translate
  - align(transcription, translation): POST /align
  - checkHealth(): GET /health
- Handle 401 (refresh token), 429 (retry with backoff), 503 (server warming up)
- Types for transcribe/align responses matching existing renderer contracts

Note: NEXT_PUBLIC_COMPUTE_GATEWAY_URL is the Cloudflare tunnel URL. JWT provides security, not URL secrecy.

Verification:
- Client compiles and types match transcription_server response shapes
```

### Prompt 2.6 — Port subtitles UI (mic only)

```
Port the Subtitles and Translation subapp to apps/web/ with browser microphone capture only.

Requirements:
- New route: src/app/subtitles/page.tsx (auth required)
- Port UI layout from index.html + styles.css: two-column transcription/translation pairs, controls bar
- Port core logic from renderer.js:
  - transcriptionPairs state, sentence splitting, pair rendering, scroll/zoom behavior (adapt zoom for browser)
  - translateText flow using compute-client.translate
  - processTranscriptionResult equivalent wired to mic capture
- Mic capture via getUserMedia + Web Audio API:
  - Volume threshold (configurable, default from electron-config.json)
  - Buffer ~3s chunks, encode float32 to base64, POST transcribe
  - No loopback/system audio — show banner: "Microphone only. Use the desktop app for system audio capture."
- On each transcription fragment: trackVocabFromText via useVocab()
- Compute status banner: poll /api/health/compute, show offline/warming states
- Disable start if compute offline

Do NOT port detail modal / semantic alignment yet (next prompt).
Do NOT port flashcards or tone-matching.

Verification:
- Mic capture → transcribe → translate → display pairs works against local gateway
- Vocab counts update during transcription session
```

### Prompt 2.7 — Port semantic detail view

```
Port the semantic unit detail modal to apps/web/subtitles using compute-client.align.

Requirements:
- Port from renderer.js: openDetailView, extractSemanticUnits flow, matchChunksToText, collectMappedChunkIds, renderChunksAsCards, setupCorrelationHighlighting
- Modal opens on pair click when both transcription and translation exist
- Call compute-client.align(transcription, translation)
- Show loading state: "Analyzing semantic units…"
- Handle alignerReady false from health — show message if alignment warms up slowly
- Cache result on transcriptionPairs[pairIndex] to avoid repeat calls

Reference ARCHITECTURE.md Semantic Unit Alignment section and main.js extract-semantic-units handler.

Verification:
- Clicking a completed pair opens modal with interactive chunk cards
- Hover highlighting works across transcription and translation sides
```

### Prompt 2.8 — Cloudflare Tunnel documentation + startup scripts

```
Add documentation and Windows-friendly startup scripts for running the home compute stack in remote mode.

Requirements:
- services/compute_gateway/README.md section on Cloudflare Tunnel:
  - Install cloudflared
  - Create tunnel pointing to localhost:8080
  - Example hostname: compute.yourdomain.com
  - Env vars for remote mode
- scripts/start_compute_stack.ps1 (PowerShell):
  - Start transcription_server.py (background or separate window — document manual steps if needed)
  - Verify Ollama is running
  - Start compute gateway with --remote and env vars from a .env.example
  - Print reminder to start cloudflared tunnel
- .env.example for home PC: JWT_SECRET, ALLOWED_ORIGINS, LINGUACODA_REMOTE_MODE, MAX_CONCURRENT_TRANSCRIPTIONS

Do not commit secrets. Do not configure Cloudflare automatically (manual dashboard steps).

Verification:
- README gives complete copy-paste setup for tunnel + gateway
- Script runs without syntax errors (dry run / echo mode acceptable)
```

---

## Phase 3 — Electron parity

### Prompt 3.1 — Electron cloud vocab sync

```
Add cloud vocab sync to the existing Electron renderer without removing localStorage fallback.

Requirements:
- Add config in electron-config.json: webApiBaseUrl (e.g. https://your-app.vercel.app)
- Create renderer-side module or section in renderer.js:
  - On login (defer login UI to Prompt 3.2 — for now accept session token via config or dev prompt): GET/PUT webApiBaseUrl/api/vocab with Bearer/session cookie
  - On app load: if authenticated, merge remote seenVocab with localStorage draft (per-word max)
  - Replace direct localStorage.setItem('seenVocab') in trackVocabFromText with sync module that updates memory + local draft
  - On window close / beforeunload: batch PUT to cloud
  - Debounced 5-min save same as web
- Keep localStorage as offline cache when not authenticated

Do not break offline-only usage when webApiBaseUrl is unset.

Verification:
- Electron vocab changes sync to same account as web when token configured
- Works offline with localStorage when webApiBaseUrl empty
```

### Prompt 3.2 — Electron Google auth flow

```
Implement Sign in with Google for the Electron app, sharing accounts with the Vercel web app.

Requirements:
- Menu or settings UI: Sign in / Sign out
- OAuth flow: open system browser or BrowserWindow to web app auth URL
- Use a dedicated callback page on Vercel: /auth/desktop-callback that displays a one-time code OR redirects to linguacoda://callback?token=...
- Electron registers linguacoda:// protocol handler (main.js) to receive callback
- Store session token securely (electron safeStorage or encrypted file)
- Pass token to vocab sync module from Prompt 3.1
- Sign out clears stored token

Prefer simple reliable flow over perfect UX for v1. Document manual test steps.

Verification:
- User can sign in via Google in Electron
- Same Google account sees same vocab on web and desktop
```

### Prompt 3.3 — Electron compute gateway routing

```
Route Electron AI calls through the Compute Gateway when configured, keeping local fallback.

Requirements:
- electron-config.json additions: computeGatewayUrl (optional), useComputeGateway (boolean)
- main.js changes:
  - translate-text IPC: if useComputeGateway, POST to computeGatewayUrl/translate with JWT (obtain from web API /api/compute/token using stored session)
  - extract-semantic-units IPC: if useComputeGateway, POST to /align on gateway
  - Fallback: existing local Ollama + 127.0.0.1:8765 behavior when not configured
- Python backend (electron_backend.py): keep direct local transcription_server when on same machine (no change) OR optionally route through gateway — document tradeoff, prefer unchanged local path for latency

Verification:
- With useComputeGateway false: Electron behaves exactly as before
- With useComputeGateway true and valid token: translation and alignment work via remote gateway
```

### Prompt 3.4 — Electron UI parity messaging

```
Update Electron UI to clarify relationship between desktop and web clients.

Requirements:
- Menu or about section:
  - "System audio capture (loopback) — desktop only"
  - Link to web app URL
  - Show signed-in email when authenticated
- Web app subtitles page already shows mic-only banner — ensure consistent messaging

Small copy/styling changes only. No new features.

Verification:
- User understands desktop vs web capability differences
```

---

## Phase 4 — Hardening

### Prompt 4.1 — Structured logging and error responses

```
Add structured logging to the Compute Gateway and consistent error JSON across services.

Requirements:
- Gateway logs: timestamp, level, endpoint, userId (from JWT sub), duration_ms, status_code
- Standard error shape: { error: string, code?: string, retryAfterSeconds?: number }
- apps/web compute-client: surface user-friendly messages for 401, 429, 503, 413
- Do not log JWTs or audio payloads

Verification:
- Failed transcribe logs one structured line with userId
- UI shows meaningful message on 429
```

### Prompt 4.2 — Production safety guards

```
Add production safety guards to apps/web/.

Requirements:
- Dev pages (/dev/*) return 404 unless NEXT_PUBLIC_ENABLE_DEV_PAGES=true
- /api/compute/token: optional rate limit per user (10/min)
- Vocab PUT: validate seenVocab is object with numeric values, reject absurd payload size (>500KB)
- Middleware or route guard: require auth on /vocab, /subtitles

Verification:
- Dev pages 404 in production config
- Invalid vocab payload returns 400
```

### Prompt 4.3 — ARCHITECTURE.md sync check

```
Review the codebase against ARCHITECTURE.md and update ARCHITECTURE.md only where implementation diverged.

Requirements:
- Compare implemented routes, env vars, file paths, and data models to ARCHITECTURE.md
- Update ARCHITECTURE.md with actual paths, any renamed endpoints, and "Implemented" notes per phase
- Do not rewrite the whole doc — surgical updates only
- Add a "Implementation status" table at the top with checkboxes per phase

Verification:
- ARCHITECTURE.md accurately reflects the repo
- No stale references to files that don't exist
```

### Prompt 4.4 — Load test script (manual)

```
Create a manual load test script for concurrent transcription sessions.

Requirements:
- scripts/load_test_compute.py:
  - Accept --url, --jwt, --sessions N, --duration seconds
  - Simulate N concurrent clients posting small transcribe payloads (or health checks if no sample audio)
  - Report: success count, 429 count, avg latency, errors
- Document in services/compute_gateway/README.md how to run against local and remote gateway
- Do not run the script automatically in CI

Verification:
- Script runs with --help
- With 3 sessions and limit 2, reports 429s
```

---

## Optional follow-up prompts

Use these after the core migration is complete.

### Optional A — WebSocket streaming transcription

```
Replace REST-per-chunk transcription in apps/web with WebSocket streaming on the Compute Gateway.

Requirements:
- Gateway: WS /stream with JWT auth on connect
- Client sends audio frames; server pushes transcription events
- Fallback to REST if WebSocket unavailable
- Update ARCHITECTURE.md data flow diagram

Verify end-to-end mic session with lower perceived latency.
```

### Optional B — Flashcards on web

```
Port the flashcards feature from renderer.js to apps/web using compute gateway for Ollama flashcard entries.

Requirements:
- Port flashcard UI and logic (getFlashcardEntry, round flow)
- Cache flashcardEntryCache in localStorage only (not DB)
- Require auth + compute online

Verify flashcard rounds work for seen vocab words.
```

### Optional C — Vercel custom domain

```
Document and configure custom domain setup for the Vercel deployment.

Requirements:
- Update apps/web/README with DNS steps
- List all Google OAuth URIs that must be updated
- Set AUTH_URL to custom domain

Verify login works on custom domain.
```

---

## Phase completion checklist

| Phase | Done when |
|-------|-----------|
| **0** | `apps/web` runs; Electron unchanged |
| **1** | Google login on Vercel; vocab syncs across devices |
| **2** | Mic transcription via tunnel; JWT-protected gateway |
| **3** | Electron shares account + vocab; optional gateway routing |
| **4** | Logging, guards, docs match code |

---

## Tips for effective prompting

- **Attach files**: `@ARCHITECTURE.md`, `@renderer.js`, `@main.js`, `@styles.css` when porting UI.
- **Scope control**: If a prompt does too much, say "only implement Prompt 1.3, do not touch UI."
- **Fix forward**: If something breaks, use a focused prompt: "Fix PUT /api/vocab merge logic; tests: ..."
- **Preserve behavior**: When porting from `renderer.js`, say "match existing behavior exactly unless noted in ARCHITECTURE.md."
