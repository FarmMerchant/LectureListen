# Mivimoose Listen

Record a lecture from your microphone and transcribe it live, or import a transcript you already have. Then have an AI (Claude, Gemini, OpenAI, or any OpenAI-compatible service) turn the transcript into organized study notes, with background chatter from students removed.

## Run it

The page must be served over `http://localhost` or `https://`. Browsers block the microphone and ES modules on `file://`.

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1   # Windows, nothing to install
npm start                                            # anywhere with Node 20+
```

Then open http://localhost:8000 in Firefox, Chrome, Edge or Safari.

## Deploy to Railway

The repo is ready for [Railway](https://railway.com): `railway.json` sets the start command (`node server.js`) and a health check (`/healthz`). The server has no dependencies and listens on Railway's `PORT`.

1. Push this folder to a GitHub repository.
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick the repository.
3. Open the service's **Settings → Networking** and click **Generate Domain**.

Railway serves the site over HTTPS, which browsers require for microphone access. With the [Railway CLI](https://docs.railway.com/guides/cli), `railway init` then `railway up` deploys from this folder without GitHub.

No environment variables or API keys go on the server. Each visitor adds their own AI key under **AI settings**, and it stays in their browser. Recordings and notes are likewise stored in each visitor's own browser, not on Railway.

## Features

- **Recording**: pause/resume, a level meter and a timer. You can pick the microphone. The screen stays awake while recording. Download the audio as `.webm` (`.ogg` on Firefox, `.m4a` on Safari).
- **Continue a lecture**: open a saved lecture and press **Continue this lecture** to record more into it, for example after a break. The timer and timestamps carry on, a "Continued" divider marks the join, and each session's audio is kept as a separate part. Playback moves from one part to the next, and clicking any timestamp plays from the right part. If automatic notes are on, the notes are regenerated when you stop. Otherwise the page reminds you to regenerate.
- **Live transcript**: timestamped lines appear as the lecturer speaks, in about 20 languages. Click a line to fix a mistake, or click its timestamp to play the audio from that point. Choose an engine under **Transcription**:
  - **Browser speech service** (Chrome, Edge, Safari): words appear instantly. Recognition restarts itself after silences or network drops.
  - **On-device Whisper**: the only option in Firefox, and available in every browser. Runs OpenAI's Whisper (base) model in the page through [Transformers.js](https://github.com/huggingface/transformers.js), so audio never leaves your device. The first use downloads an ~80 MB model, which the browser then caches. Audio is split at pauses in speech and transcribed a few seconds behind the speaker, about 2× faster than real time on a typical laptop. When you press Stop, the page waits for the last chunk before saving.
- **Import a transcript**: click **Import transcript** (top right) or drop files anywhere on the page. You can import several files at once; each is saved to the library and summarized in turn. Supported formats:
  - `.srt` and `.vtt` subtitles (Zoom, Teams, YouTube). Duplicate and rolling captions are removed.
  - Timestamped lines such as `[12:34] text`, including this app's own `.txt` export
  - Speaker blocks such as Otter's `Speaker 1  0:03`
  - Plain `.txt` or `.md` text, split into paragraphs

  Save Word or PDF transcripts as `.txt` first.
- **Notes**: runs when you stop recording or import a file, or when you press **Generate notes**. It produces:
  - a short summary
  - study notes grouped by topic, with key terms, examples, announcements and to-dos, and review questions
  - formulas written in LaTeX (`$…$` inline, `$$…$$` or `\[…\]` on their own line) and rendered with [KaTeX](https://katex.org). The downloaded `.md` keeps the LaTeX, so it also renders in Obsidian, Notion or Typora.
  - a list of transcript lines judged to be student chatter. These lines are hidden, not deleted. Use **Show removed** to see them and **Restore** to bring one back, or **Remove** any line yourself.
- **Library**: recordings, transcripts and notes are saved in the browser (IndexedDB) and autosaved every 30 seconds while recording. If the tab closes mid-lecture, the recording so far is recovered.
- **Merge lectures**: in the library, click **Select to merge**, tick two or more lectures, and click **Merge**. Recordings and imported transcripts can be mixed.
  - They're joined in the order they were recorded into a new lecture. The timeline runs on from one to the next, and a divider names each source lecture.
  - Audio parts, chatter marks and your edits carry over.
  - If an AI provider is set up, the merged lecture gets fresh notes.
  - The originals are kept unless you tick **Delete the originals after merging**.
- **Exports**: transcript `.txt` (chatter excluded), notes `.md`, audio.

## AI setup

Open **AI settings** under Notes, pick a provider, and paste its API key. Choose a model from the dropdown. It lists recommended models, plus every model your key can use once the key is saved. For a model that isn't listed, choose **Other model…** and type its name.

Gemini only accepts keys created on or after May 28, 2026 ("auth keys"). If Gemini rejects an older key, create a new one at aistudio.google.com/api-keys.

| Provider | Get a key | Default model | How it's called |
|---|---|---|---|
| Anthropic Claude | console.anthropic.com | `claude-opus-5` | Official `@anthropic-ai/sdk`, structured JSON output |
| Google Gemini | aistudio.google.com/apikey | `gemini-3.8-flash` | `generateContent` with a JSON schema |
| OpenAI | platform.openai.com/api-keys | `gpt-6-sol` | Chat Completions with a JSON schema |
| OpenAI-compatible | your service | (enter one) | `{base URL}/chat/completions`; falls back to JSON mode, then plain text, if the server doesn't support schemas |

For OpenAI-compatible services, enter the base URL, for example:
- `https://openrouter.ai/api/v1`
- `https://api.groq.com/openai/v1`
- `http://localhost:11434/v1` for Ollama. Start it with `OLLAMA_ORIGINS=http://localhost:8000` so the page is allowed to call it. No key is needed.

Each provider's key is stored separately in this browser's localStorage and sent only to that provider. Requests go directly from the browser. Keys are never written into the site's files, so a hosted copy is safe to share: each visitor uses their own key. Don't save a key on a shared or public computer.

## Privacy notes

- The **Browser speech service** engine in Chrome and Edge sends audio to Google or Microsoft for recognition. **On-device Whisper** keeps audio local; only the model files are downloaded, from Hugging Face.
- When you generate notes, the transcript text (not the audio) is sent to the AI provider you chose.
- Everything else stays in your browser.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styles, light/dark |
| `app.js` | Recording, live transcription, transcript editing, library |
| `notes.js` | AI providers (Claude, Gemini, OpenAI, compatible), prompt, and a small safe Markdown + LaTeX renderer |
| `transcript-import.js` | Parses imported `.srt`, `.vtt`, timestamped and plain-text transcripts |
| `whisper.js` | On-device transcription: model loading, resampling to 16 kHz, splitting at pauses |
| `whisper-worker.js` | Web Worker that runs Whisper with Transformers.js |
| `pcm-worklet.js` | AudioWorklet that streams raw microphone samples |
| `plexus.js` | Animated network background. Frozen while recording, when the tab is hidden, or with "reduce motion" |
| `server.js` | Zero-dependency Node server for hosting (Railway) and `npm start`; serves only the app's files |
| `package.json` / `railway.json` | Start script and Railway deploy settings |
| `serve.ps1` | Zero-dependency local server for Windows |
