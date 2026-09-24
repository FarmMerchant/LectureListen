// Runs Whisper speech recognition off the main thread with Transformers.js.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let transcriber = null;
let loading = null;
let queue = Promise.resolve();

async function load(model) {
  transcriber = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' || p.status === 'done') {
        self.postMessage({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  });
}

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'load') {
    loading ??= load(msg.model).then(
      () => self.postMessage({ type: 'ready' }),
      (err) => {
        self.postMessage({ type: 'error', message: err?.message || String(err) });
        throw err;
      },
    );
  } else if (msg.type === 'transcribe') {
    // One chunk at a time, in the order they arrive.
    queue = queue.then(async () => {
      try {
        await loading;
        const out = await transcriber(msg.audio, { language: msg.language, task: 'transcribe' });
        self.postMessage({ type: 'result', id: msg.id, text: out.text || '' });
      } catch (err) {
        self.postMessage({ type: 'result', id: msg.id, text: '', error: err?.message || String(err) });
      }
    });
  }
};
