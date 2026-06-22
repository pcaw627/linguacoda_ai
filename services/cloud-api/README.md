# LinguaCoda Cloud API

Minimal [Next.js](https://nextjs.org) App Router service deployed to **Vercel**. This is **not** the LinguaCoda product UI — it provides:

- Google OAuth (Auth.js)
- Vocab read/write API (`GET/PUT /api/vocab`)
- Desktop API tokens for Electron (`POST /api/auth/desktop-token`)
- Health check (`GET /api/health`)

The **Electron desktop app** (repo root) is the only end-user client. It handles transcription, subtitles, WASAPI capture, and the vocab grid.

## Local development

```powershell
cd services/cloud-api
cp .env.example .env.local
# Edit .env.local with DATABASE_URL, AUTH_SECRET, Google OAuth credentials
npm install
npx prisma migrate dev --name init
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — landing page with dev Sign in / Sign out for OAuth testing.

From the repo root:

```powershell
npm run dev:api
```

## Database

After setting `DATABASE_URL` in `.env.local`:

```powershell
npx prisma migrate dev --name init
```

For production (Vercel deploy hook or manual):

```powershell
npx prisma migrate deploy
```

## API authentication

Two methods are supported on `/api/vocab`:

1. **Browser session** — Auth.js cookie (dev testing in browser)
2. **Electron API token** — `Authorization: Bearer <token>` from `POST /api/auth/desktop-token`

### Desktop token flow

1. Electron opens system browser → `/api/auth/signin/google?callbackUrl=/auth/desktop-callback`
2. After Google login, `/auth/desktop-callback` redirects to `linguacoda://auth/callback?code=...`
3. Electron exchanges the one-time code: `POST /api/auth/desktop-token` with `{ "code": "..." }`
4. Response: `{ "token": "...", "expiresInDays": 90 }` — store in Electron `safeStorage`

Tokens are stored as SHA-256 hashes in the `ApiToken` table. One-time codes expire in 5 minutes.

### Vocab merge

Server and client both use per-word max merge:

```
merged[word] = max(existing[word] ?? 0, incoming[word] ?? 0)
```

`seenVocab` shape matches Electron `localStorage.seenVocab`: `{ [word: string]: number }`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev server (port 3000) |
| `npm run build` | `prisma generate` + production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |

## Vercel deployment checklist

1. Create a Vercel project with **root directory** = `services/cloud-api`
2. Add a PostgreSQL database (Vercel Postgres, Neon, or Supabase) and set `DATABASE_URL`
3. Set environment variables:

   | Variable | Value |
   |----------|-------|
   | `DATABASE_URL` | PostgreSQL connection string |
   | `AUTH_SECRET` | Random secret (`openssl rand -base64 32`) |
   | `GOOGLE_CLIENT_ID` | Google OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
   | `AUTH_URL` | `https://<your-domain>` (no trailing slash) |

4. Google Cloud Console → OAuth client → **Authorized redirect URIs**:
   - `https://<your-domain>/api/auth/callback/google`
5. Run migrations against production DB:
   ```powershell
   DATABASE_URL="..." npx prisma migrate deploy
   ```
6. Deploy — build runs `prisma generate && next build` automatically
7. Set `cloudApiBaseUrl` in Electron `electron-config.json` to your Vercel URL

`.env.local` is gitignored; never commit secrets.

## Manual test: vocab with Bearer token

```powershell
# After desktop-token exchange:
curl -H "Authorization: Bearer YOUR_TOKEN" https://your-api.vercel.app/api/vocab
curl -X PUT -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" `
  -d '{"seenVocab":{"你好":3}}' https://your-api.vercel.app/api/vocab
```

## What does not live here

Do not copy Electron assets into this package:

- `renderer.js`, `styles.css`, `hsk_dictionary.json` — stay in the desktop app
- Subtitles UI, audio capture, or vocab grid

See [ARCHITECTURE.md](../../ARCHITECTURE.md) and [MIGRATION_PROMPTS.md](../../MIGRATION_PROMPTS.md).
