# LectureListen

Record a lecture from your microphone, transcribe it live, then have Claude turn the transcript into organized study notes, with background chatter from students removed.

## Run it

The page must be served over `http://localhost` or `https://`. Browsers block the microphone and ES modules on `file://`.

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8000 in Firefox, Chrome, Edge or Safari. Any other static server works too.

## Features

- **Recording**: pause/resume, a level meter and a timer. You can pick the microphone. The screen stays awake while recording. Download the audio as `.webm` (`.m4a` on Safari).
- **Live transcript**: timestamped lines appear as the lecturer speaks, in about 20 languages. Click a line to fix a mistake, or click its timestamp to play the audio from that point. Choose an engine under **Transcription**:
  - **Browser speech service** (Chrome, Edge, Safari): words appear instantly. Recognition restarts itself after silences or network drops.
  - **On-device Whisper**: the only option in Firefox, and available in every browser. Runs OpenAI's Whisper (base) model in the page through [Transformers.js](https://github.com/huggingface/transformers.js), so audio never leaves your device. The first use downloads an ~80 MB model, which the browser then caches. Audio is split at pauses in speech and transcribed a few seconds behind the speaker, about 2× faster than real time on a typical laptop. When you press Stop, the page waits for the last chunk before saving.
- **Notes (Claude)**: runs when you stop recording, or when you press **Generate notes**. It produces:
  - a short summary
  - study notes grouped by topic, with key terms, examples, announcements and to-dos, and review questions
  - a list of transcript lines judged to be student chatter. These lines are hidden, not deleted. Use **Show removed** to see them and **Restore** to bring one back, or **Remove** any line yourself.
- **Library**: recordings, transcripts and notes are saved in the browser (IndexedDB) and autosaved every 30 seconds while recording. If the tab closes mid-lecture, the recording so far is recovered.
- **Exports**: transcript `.txt` (chatter excluded), notes `.md`, audio.

## Claude setup

Open **Claude settings** under Notes and paste an Anthropic API key from https://console.anthropic.com. The key is stored in this browser's localStorage and sent only to `api.anthropic.com`. The page calls the API directly from the browser through the official `@anthropic-ai/sdk`, loaded from jsDelivr. So use it on your own machine, and don't host it publicly with your key saved in it.

Model: `claude-opus-5` with adaptive thinking and structured JSON output, set in [notes.js](notes.js).

## Privacy notes

- The **Browser speech service** engine in Chrome and Edge sends audio to Google or Microsoft for recognition. **On-device Whisper** keeps audio local; only the model files are downloaded, from Hugging Face.
- When you generate notes, the transcript text (not the audio) is sent to Anthropic.
- Everything else stays in your browser.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styles, light/dark |
| `app.js` | Recording, live transcription, transcript editing, library |
| `notes.js` | Claude call, prompt, and a small safe Markdown renderer |
| `whisper.js` | On-device transcription: model loading, resampling to 16 kHz, splitting at pauses |
| `whisper-worker.js` | Web Worker that runs Whisper with Transformers.js |
| `pcm-worklet.js` | AudioWorklet that streams raw microphone samples |
| `serve.ps1` | Zero-dependency local server |
