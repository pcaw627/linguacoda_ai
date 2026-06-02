# LinguaCoda AI — Architecture

This document describes the high-level design of the LinguaCoda desktop app: how audio is captured, transcribed, translated, displayed, and extended with language-learning features.

## Overview

The project is an **Electron desktop app** with:

- **Electron Main Process (Node.js)**: owns the app window, starts the Python backend, provides IPC handlers, and performs LLM calls for translation/analysis.
- **Electron Renderer (HTML/CSS/JS)**: the UI, state management for pairs, scrolling/zoom behavior, and the semantic-unit detail view.
- **Python Backend (`electron_backend.py`)**: captures audio from the selected device, buffers it, talks to an external transcription server, and streams transcription results to Electron via stdout.
- **Transcription Server (`transcription_server.py` + `transcription_client.py`)**: a local HTTP service that performs **ASR via SenseVoice** (see `sensevoice_transcriber.py`), **cross-lingual word alignment via SimAlign** (`semantic_aligner.py`), and returns transcription or alignment results.

At runtime the flow looks like:

1. Electron starts and creates a window.
2. Electron starts (or connects to) the transcription server.
3. Electron starts the Python backend as a child process.
4. Renderer requests devices/config over IPC and drives capture start/stop.
5. Python backend captures audio and emits transcription events.
6. Renderer appends transcription fragments; Electron main process translates each fragment via LLM; Renderer displays pairs and enables detail analysis.

## AI Components (Where the “AI” Lives)

This project has **three distinct AI subsystems**:

1) **Speech-to-Text (ASR)** — runs in the **transcription server** (Python), implemented with **SenseVoice**.
2) **Cross-lingual word alignment** — runs in the **transcription server** (Python), implemented with **pkuseg + SimAlign** (XLM-R embeddings, IterMax matching) for the semantic-unit detail view.
3) **Text-to-Text LLM tasks** — run in the **Electron main process** (Node) by calling a local **Ollama** endpoint:
   - Translation (transcription → English)
   - Vocab context generation (optional learning features)

### ASR: SenseVoice Transcription

- **Where**: `transcription_server.py` instantiates a `SenseVoiceTranscriber` (from `sensevoice_transcriber.py`).
- **How**: the Python backend (`electron_backend.py`) sends buffered audio to the transcription server via `TranscriptionClient` (`transcription_client.py`).
- **Model**: controlled in `config.py` via `SENSEVOICE_MODEL` (defaults to `iic/SenseVoiceSmall`).
- **Outputs**:
  - `transcription`: recognized text
  - `detectedLang`: language ID when available (used by the UI for “Detected: …”)

### LLM: Translation via Ollama

- **Where**: Electron main process (`main.js`) exposes an IPC handler `translate-text`.
- **How**: `translate-text` calls Ollama’s `POST /api/generate` using `axios`.
- **Prompt shape**: the translation prompt instructs: “Only provide the translation, no explanations”.
- **Config**: `electron-config.json`
  - `ollamaEndpoint` (default `http://127.0.0.1:11434`)
  - `ollamaModel` (e.g. `gemma3:4b`)

### Semantic Unit Alignment (Detail View) via SimAlign

- **Where**: `semantic_aligner.py`, served by `transcription_server.py` at `POST /align`. Electron main process (`main.js`) IPC handler `extract-semantic-units` proxies to that endpoint.
- **How** — deterministic pipeline (no LLM, no JSON parsing):
  1. **Strip parentheticals** from both sides (ASCII `()` and full-width `（）`), so clarifiers like `(referring to X)` never become chunks.
  2. **Tokenize** each side independently:
     - **Chinese** (any Han characters): **pkuseg** word segmentation — multi-character words like `墨西哥城` stay one chunk.
     - **English / Latin**: whitespace split with outer punctuation stripped; inner punctuation preserved (`8,000`, `don't`).
  3. **Align** with **SimAlign** (`xlm-roberta-base`, IterMax matching) on the token lists. IterMax derives many-to-many links from XLM-R cosine similarity (e.g. `墨西哥城` → `["Mexico", "City"]`).
  4. **Package** chunks + correlations for the renderer (`t1`… / `e1`… IDs, `matches` arrays per transcription chunk).
- **Warmup**: aligner + pkuseg load in a background thread at server startup so the first detail-view open isn't blocked on model download.
- **Auth**: same Bearer token as `/transcribe` (`.transcription_server.token`).
- **Return shape** (from `/align`, wrapped by IPC as `{ success: true, … }`):
  ```json
  {
    "transcriptionChunks": [{"id": "t1", "text": "…"}, …],
    "translationChunks":  [{"id": "e1", "text": "…"}, …],
    "correlations": [{"id": "t1", "matches": ["e1", "e2"]}, {"id": "t2", "matches": []}, …]
  }
  ```
- **Renderer usage**:
  - Renderer calls `window.electronAPI.extractSemanticUnits(transcription, translation)`
  - Modal shows "Analyzing semantic units…" while waiting
  - On success, chunks are matched back to character positions in the original text. **Only chunks that appear in some mapping** are rendered as interactive cards; **unmapped chunks render as plain text**.
  - Hover highlighting uses the correlation map (bidirectional, with sibling links across multi-match groups).

## Process & Module Responsibilities

### Electron Main Process (`main.js`)

**Responsibilities**
- Creates the `BrowserWindow` and loads `index.html`.
- Manages app lifecycle: start/stop processes.
- Spawns the Python backend (`electron_backend.py`) and bridges stdout JSON events into renderer events.
- Hosts IPC handlers for:
  - Configuration retrieval
  - Capture control (start/stop)
  - Device enumeration / device selection persistence
  - Translation (LLM call via Ollama)
  - Semantic-unit alignment (HTTP proxy to transcription server `/align`)

**Key concept: “IPC is the seam”**
- The renderer never calls Python directly.
- The renderer never calls the LLM endpoint directly.
- Instead, the renderer calls `window.electronAPI.*` methods (from `preload.js`), which map to `ipcMain.handle(...)` handlers in `main.js`.

### Preload Bridge (`preload.js`)

**Responsibilities**
- Exposes a safe, explicit API (`window.electronAPI`) to the renderer via `contextBridge`.
- Wraps IPC invocations (`ipcRenderer.invoke`) and event listeners (`ipcRenderer.on`) so the renderer can:
  - Request config / devices
  - Start/stop capture
  - Translate text
  - Extract semantic units (detail view)
  - Receive events: transcription results, errors, audio device lists

### Renderer / UI (`index.html`, `styles.css`, `renderer.js`)

**Responsibilities**
- UI layout and styling.
- User interactions: device selection, start/stop capture, language selection, volume threshold, zoom, scrolling, and detail modal behavior.
- Maintains the core UI state:
  - `transcriptionPairs[]`: list of `{ transcription, translation }`
  - capture state (`isCapturing`)
  - language state (selected vs detected)

**View structure**
- A top-level “suite” UI with a **menu screen** and a **subapp screen**:
  - Menu shows “LinguaCoda Language Learning Suite” + navigation button.
  - “Subtitles and Translation” transitions to the existing transcription/translation UI unchanged.

### Python Backend (`electron_backend.py`)

**Responsibilities**
- Enumerates audio devices (often via `audio_capture.py`).
- Captures audio from selected device (mic or loopback output), applying:
  - volume threshold checks
  - buffering + silence detection rules
- Calls the transcription client (`TranscriptionClient`) which talks to the transcription server.
- Emits messages to Electron via **stdout** as JSON, e.g.:
  - `{ "type": "transcription", "data": { "transcription": "...", "detectedLang": "..." } }`
  - `{ "type": "audio-devices", "data": ... }`
  - `{ "type": "error", "data": ... }`

**Important design detail**
- The Python backend is intentionally “headless.” It does not render UI and does not call Ollama. Its AI-related responsibility is **feeding audio to the transcription server and forwarding ASR results upstream**.

### Transcription Server (`transcription_server.py`)

**Responsibilities**
- HTTP API:
  - `POST /transcribe` — audio payloads → transcription text + metadata.
  - `POST /align` — `{ transcription, translation }` → semantic chunks + correlations (`semantic_aligner.py`).
  - `GET /health` — includes `ready` (ASR) and `alignerReady` (pkuseg + SimAlign loaded).
- Owns the **ASR model runtime** (SenseVoice via `sensevoice_transcriber.py`) and the **alignment runtime** (pkuseg + SimAlign / XLM-R).
- Designed to be started by Electron (or already running), with health/readiness checks in the client.

## Data Flow (End-to-End)

### Audio → Transcription

1. Renderer calls `window.electronAPI.startCapture(deviceId, deviceType)`.
2. Main process forwards to the Python backend via stdin (JSON command).
3. Python backend starts capturing and buffering audio.
4. On buffer completion, backend calls transcription server.
5. Backend prints JSON transcription messages to stdout.
6. Main process reads stdout, parses JSON, and forwards to renderer via `webContents.send('transcription-result', data)`.
7. Renderer receives the transcription event and processes it.

### Transcription → Sentence Fragments → Translation Pairs

Renderer performs **sentence splitting** so each “sentence-like fragment” becomes its own pair:

- Incoming transcription text is split by sentence-ending punctuation (e.g., `.`, `..`, `...`, `。`, `．`).
- Each fragment becomes:
  - `transcriptionPairs.push({ transcription: fragment, translation: '' })`
  - then an async translation request is triggered for that fragment.

Translation is performed in the main process (LLM call) via:
- `window.electronAPI.translateText(fragment)` → `ipcMain.handle('translate-text', ...)` → LLM endpoint.

Semantic unit alignment (for the detail modal):
- `window.electronAPI.extractSemanticUnits(transcription, translation)` → `ipcMain.handle('extract-semantic-units', ...)` → `POST http://127.0.0.1:8765/align` (SimAlign).

### Display: Aligned Pair Rendering

The UI renders transcription pairs as two synchronized columns:

- Left: transcription
- Right: translation

Pairs are rendered as aligned “blocks,” and heights are normalized to keep the left/right row outlines aligned.

## UX/Behavior Features

### Menu Navigation

The app starts in a menu screen and transitions to the “Subtitles and Translation” subapp without altering that subapp’s internal layout.

### Capture-Time Scrolling Rules

The renderer distinguishes two states:

- **When capturing (`isCapturing === true`)**
  - Always autoscroll to the bottom as new content arrives.
  - User scrolling is blocked (wheel scrolling prevented), but **Ctrl+scroll zoom** remains enabled.

- **When not capturing**
  - No forced autoscroll.
  - User can scroll freely as normal.

This ensures live capture stays “followed” like a log, while still allowing review when stopped.

### Zoom

Zoom is implemented as a font-size adjustment driven by Ctrl+mousewheel on the content area.

### Detail View (Semantic Unit Mapping)

Clicking either side of a pair opens a modal detail view that maps semantic units between the two sentences.

**When it runs**
- The detail view requires both transcription and translation to exist for the selected pair.

**How it works**
1. Renderer opens modal and shows a loading state.
2. Renderer calls `window.electronAPI.extractSemanticUnits(transcription, translation)`.
3. Main process forwards the pair to the transcription server's `/align` endpoint (`semantic_aligner.py`):
   - strips parenthetical clarifiers/tags
   - tokenizes Chinese with **pkuseg**, English with whitespace + punctuation rules
   - runs **SimAlign** (XLM-R + IterMax) for many-to-many word alignment
4. Renderer receives `{ transcriptionChunks, translationChunks, correlations }` and:
   - matches each chunk back to its character position in the original sentence text
   - renders mapped chunks as "rounded corners cards" and unmapped chunks as plain text
   - builds a bidirectional correlation map (with sibling links across multi-match groups) so hovering any card highlights every linked card on both sides

**Rendering strategy**
- `matchChunksToText` walks through the chunk list in order, searching forward in the original text to find each chunk's position (handles repeated words by advancing a cursor).
- `collectMappedChunkIds` scans the correlations and returns the set of all chunk IDs (`t*` and `e*`) that participate in at least one non-empty mapping.
- `renderChunksAsCards` renders each segment as either an interactive card (if its chunk ID is in the mapped set) or a plain text node (if it isn't). Gaps between segments are always plain text.
- `setupCorrelationHighlighting` builds a `chunkId → Set<chunkId>` map from the correlations array — bidirectional between transcription and translation, and across siblings within a multi-match group — and highlights linked cards on hover.

## Configuration & Persistence

- App-level settings live in `config.py` (Python) and `electron-config.json` (Electron).
- Audio device selections are cached in `device_cache.json` and managed by `device_cache.py`.
- The renderer stores some UX preferences (e.g., font size) in `localStorage`.

## Error Handling & Resilience

- Python backend emits `error` messages to Electron when capture/transcription fails.
- Main process forwards errors to renderer so UI can display status updates.
- Transcription server readiness is checked; startup includes retries/waits.
- LLM calls (translation, vocab context) and alignment (`/align`) handle network errors, timeouts, and missing/invalid responses.
- First `/align` after a cold start may take longer while XLM-R loads (~1 GB); the server warms up the aligner in a background thread at startup.

## Extensibility Notes

Suggested extension points:

- **Add new “suite” tools**: add a new menu button + a new view container in `index.html`, and route via renderer navigation helpers.
- **Add new analyses for a pair**: add new IPC handlers in `main.js`, expose in `preload.js`, and add UI components in renderer.
- **Improve sentence splitting**: extend the sentence-end regex to include `?`, `!`, `！？`, `…` (unicode ellipsis), etc.
- **Cache semantic unit results**: store extracted units on `transcriptionPairs[pairIndex]` to avoid repeated `/align` calls.
- **Tune alignment**: adjust SimAlign matching method or add a cosine-similarity threshold in `semantic_aligner.py` if spurious links appear.

