// On-device transcription with Whisper, for browsers without the Web Speech API
// (Firefox) or for anyone who wants audio to stay on their machine.
// Audio is split at pauses in speech and transcribed chunk by chunk in a worker.

export const WHISPER_MODEL = 'onnx-community/whisper-base';
const RATE = 16000; // Whisper's input sample rate

const MIN_CHUNK_S = 4; // don't cut before this much audio...
const MAX_CHUNK_S = 20; // ...and always cut by this point
const CUT_SILENCE_S = 0.6; // pause length that ends a chunk
const MIN_VOICED_MS = 300; // chunks with less speech than this are skipped

let worker = null;
let ready = null;
let nextId = 1;
const pending = new Map();
let statusListener = null;

/**
 * Starts downloading/initialising the model (cached by the browser after the
 * first time). Safe to call repeatedly.
 * @param {(status: {phase: 'download'|'ready'|'error', percent?: number, message?: string}) => void} [onStatus]
 */
export function loadWhisper(onStatus) {
  if (onStatus) statusListener = onStatus;
  if (ready) return ready;

  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  const files = new Map();

  ready = new Promise((resolve, reject) => {
    worker.onmessage = ({ data: msg }) => {
      if (msg.type === 'progress') {
        const prev = files.get(msg.file) || { loaded: 0, total: 0 };
        const total = msg.total || prev.total;
        files.set(msg.file, { total, loaded: msg.status === 'done' ? total : msg.loaded ?? prev.loaded });
        let loaded = 0;
        let sum = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          sum += f.total;
        }
        if (sum) statusListener?.({ phase: 'download', percent: Math.round((loaded / sum) * 100) });
      } else if (msg.type === 'ready') {
        statusListener?.({ phase: 'ready' });
        resolve();
      } else if (msg.type === 'error') {
        statusListener?.({ phase: 'error', message: msg.message });
        reject(new Error(msg.message));
      } else if (msg.type === 'result') {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    };
    worker.onerror = (e) => {
      const message = e.message || 'The speech model failed to start.';
      statusListener?.({ phase: 'error', message });
      reject(new Error(message));
    };
  });

  // Let a later call retry after a failed download.
  ready.catch(() => {
    worker?.terminate();
    worker = null;
    ready = null;
    for (const resolve of pending.values()) resolve({ text: '', error: 'Speech model unavailable' });
    pending.clear();
  });

  worker.postMessage({ type: 'load', model: WHISPER_MODEL });
  return ready;
}

function transcribe(audio, language) {
  if (!worker) return Promise.resolve({ text: '', error: 'Speech model unavailable' });
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

// Box-filter downsampler that carries leftover samples between blocks.
class Downsampler {
  constructor(inputRate) {
    this.ratio = inputRate / RATE;
    this.carry = new Float32Array(0);
  }

  process(block) {
    if (this.ratio === 1) return block;
    const input = new Float32Array(this.carry.length + block.length);
    input.set(this.carry);
    input.set(block, this.carry.length);
    const outLength = Math.floor(input.length / this.ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * this.ratio);
      const end = Math.floor((i + 1) * this.ratio);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    }
    this.carry = input.slice(Math.floor(outLength * this.ratio));
    return out;
  }
}

// Whisper tends to invent these on noise or near-silence.
const NON_SPEECH = /^\s*([[(♪*].*[\])♪*]|\.+|-+)\s*$/;
const SHORT_HALLUCINATIONS = /^\s*(thank you\.?|thanks for watching!?|you|bye\.?)\s*$/i;

export class WhisperSession {
  /**
   * @param {{ language: string, inputRate: number,
   *           onSegment: (text: string, startMs: number) => void,
   *           onBacklog?: (count: number) => void,
   *           onError?: (message: string) => void }} options
   */
  constructor({ language, inputRate, onSegment, onBacklog, onError }) {
    this.language = language.split('-')[0].toLowerCase();
    this.down = new Downsampler(inputRate);
    this.onSegment = onSegment;
    this.onBacklog = onBacklog;
    this.onError = onError;
    this.jobs = new Set();
    this.noise = null;
    this.errored = false;
    this.reset();
  }

  reset(keep = null) {
    this.parts = keep ? [keep] : [];
    this.length = keep ? keep.length : 0;
    this.voiced = 0;
    this.lastVoice = 0;
    this.startMs = null;
  }

  /** @param {Float32Array} block raw samples at inputRate; @param {number} nowMs recording time at the end of the block */
  push(block, nowMs) {
    const samples = this.down.process(block);
    if (!samples.length) return;

    let sum = 0;
    for (const v of samples) sum += v * v;
    const rms = Math.sqrt(sum / samples.length);
    // Track the room's noise floor: fall quickly, rise slowly.
    this.noise = this.noise === null ? rms
      : rms < this.noise ? this.noise * 0.8 + rms * 0.2
        : this.noise * 0.995 + rms * 0.005;
    const isVoiced = rms > Math.max(0.005, this.noise * 2);

    if (this.startMs === null) this.startMs = Math.max(0, nowMs - ((this.length + samples.length) / RATE) * 1000);
    this.parts.push(samples);
    this.length += samples.length;
    if (isVoiced) {
      this.voiced += samples.length;
      this.lastVoice = this.length;
    }

    const seconds = this.length / RATE;
    const silence = (this.length - this.lastVoice) / RATE;
    if (!this.voiced && seconds > 1.5) {
      this.reset(samples); // only silence so far: drop it, keep the latest block for speech onsets
    } else if ((seconds >= MIN_CHUNK_S && silence >= CUT_SILENCE_S) || seconds >= MAX_CHUNK_S) {
      this.cut();
    }
  }

  /** Sends whatever audio is buffered for transcription. */
  cut() {
    if (!this.length) return;
    const audio = new Float32Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      audio.set(part, offset);
      offset += part.length;
    }
    const startMs = this.startMs ?? 0;
    const voicedMs = (this.voiced / RATE) * 1000;
    this.reset();
    if (voicedMs < MIN_VOICED_MS) return;

    const job = transcribe(audio, this.language).then(({ text, error }) => {
      if (error) {
        if (!this.errored) this.onError?.(error);
        this.errored = true;
        return;
      }
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || NON_SPEECH.test(clean) || (voicedMs < 1500 && SHORT_HALLUCINATIONS.test(clean))) return;
      this.onSegment(clean, startMs);
    });
    this.jobs.add(job);
    this.onBacklog?.(this.jobs.size);
    job.finally(() => {
      this.jobs.delete(job);
      this.onBacklog?.(this.jobs.size);
    });
  }

  /** Flushes the buffer and resolves once every chunk has been transcribed. */
  async drain() {
    this.cut();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}
