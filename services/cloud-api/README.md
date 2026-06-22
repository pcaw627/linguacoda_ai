# LinguaCoda Cloud API

Minimal [Next.js](https://nextjs.org) App Router service deployed to **Vercel**. This is **not** the LinguaCoda product UI — it provides:

- Google OAuth (Auth.js) — Phase 1
- Vocab read/write API — Phase 1
- Compute token issuance — Phase 2

The **Electron desktop app** (repo root) is the only end-user client. It handles transcription, subtitles, WASAPI capture, and the vocab grid.

## Local development

```powershell
cd services/cloud-api
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you should see a static landing page with "Desktop app required".

From the repo root:

```powershell
npm run dev:api
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev server (port 3000) |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |

## Vercel deployment

Set the Vercel project **root directory** to `services/cloud-api`.

Environment variables and database setup are added in Phase 1. See [ARCHITECTURE.md](../../ARCHITECTURE.md) and [MIGRATION_PROMPTS.md](../../MIGRATION_PROMPTS.md).

## What does not live here

Do not copy Electron assets into this package:

- `renderer.js`, `styles.css`, `hsk_dictionary.json` — stay in the desktop app
- Subtitles UI, audio capture, or vocab grid
