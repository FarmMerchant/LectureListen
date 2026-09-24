import { generateNotes, renderMarkdown } from './notes.js';
import { loadWhisper, WhisperSession } from './whisper.js';

const $ = (id) => document.getElementById(id);

const els = {
  banner: $('banner'),
  title: $('title'),
  micSelect: $('micSelect'),
  langSelect: $('langSelect'),
  engineSelect: $('engineSelect'),
  engineHint: $('engineHint'),
  viz: $('viz'),
  statusPill: $('statusPill'),
  timer: $('timer'),
  recordBtn: $('recordBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  notice: $('notice'),
  playback: $('playback'),
  player: $('player'),
  downloadAudioBtn: $('downloadAudioBtn'),
  newBtn: $('newBtn'),
  wordCount: $('wordCount'),
  chatterToggle: $('chatterToggle'),
  copyBtn: $('copyBtn'),
  downloadTxtBtn: $('downloadTxtBtn'),
  transcript: $('transcript'),
  emptyState: $('emptyState'),
  segments: $('segments'),
  interim: $('interim'),
  notesStatus: $('notesStatus'),
  generateBtn: $('generateBtn'),
  copyNotesBtn: $('copyNotesBtn'),
  downloadNotesBtn: $('downloadNotesBtn'),
  settings: $('settings'),
  apiKey: $('apiKey'),
  saveKeyBtn: $('saveKeyBtn'),
  clearKeyBtn: $('clearKeyBtn'),
  autoNotes: $('autoNotes'),
  notesBody: $('notesBody'),
  libraryCount: $('libraryCount'),
  libraryList: $('libraryList'),
  libraryEmpty: $('libraryEmpty'),
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const LANGUAGES = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'],
  ['en-CA', 'English (Canada)'], ['en-IN', 'English (India)'], ['es-ES', 'Español (España)'],
  ['es-MX', 'Español (México)'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'],
  ['pt-BR', 'Português (Brasil)'], ['nl-NL', 'Nederlands'], ['pl-PL', 'Polski'], ['ru-RU', 'Русский'],
  ['tr-TR', 'Türkçe'], ['ar-SA', 'العربية'], ['hi-IN', 'हिन्दी'], ['zh-CN', '中文 (普通话)'],
  ['ja-JP', '日本語'], ['ko-KR', '한국어'],
];

const STATUS_LABELS = {
  idle: 'Ready', recording: 'Recording', paused: 'Paused', stopping: 'Finishing…', stopped: 'Saved',
};

// --- Preferences (per-browser conveniences) ---------------------------------

const PREFS_KEY = 'lecturelisten:prefs';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Storage unavailable (private window, blocked site data): prefs just won't persist.
  }
}

// --- Lecture storage (IndexedDB) ---------------------------------------------

const db = {
  promise: null,
  open() {
    this.promise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('lecturelisten', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('lectures', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.promise;
  },
  async run(mode, fn) {
    const conn = await this.open();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('lectures', mode);
      const req = fn(tx.objectStore('lectures'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  put: (lecture) => db.run('readwrite', (s) => s.put(lecture)),
  get: (id) => db.run('readonly', (s) => s.get(id)),
  all: () => db.run('readonly', (s) => s.getAll()),
  remove: (id) => db.run('readwrite', (s) => s.delete(id)),
};

async function persist(lecture) {
  try {
    await db.put(lecture);
  } catch (err) {
    console.error(err);
    showNotice(err?.name === 'QuotaExceededError'
      ? 'The browser is out of storage space. Download your recording now so it isn’t lost.'
      : 'Couldn’t save to browser storage. Download your recording to keep it.');
  }
}

// --- State ----------------------------------------------------------------------

const state = {
  status: 'idle', // idle | recording | paused | stopping | stopped
  lecture: null, // the lecture on screen
  stream: null,
  recorder: null,
  chunks: [],
  recognition: null,
  recognitionBlocked: false,
  whisper: null, // on-device transcription session
  whisperBacklog: 0,
  modelStatus: '', // e.g. download progress
  modelReady: false,
  audioSource: null,
  recognitionFailures: 0,
  utteranceStart: null,
  interim: '',
  accumulated: 0,
  runStart: 0,
  audioCtx: null,
  analyser: null,
  levels: [],
  rafId: 0,
  timerId: 0,
  autosaveId: 0,
  wakeLock: null,
  audioUrl: null,
  noticeKind: null,
  showChatter: false,
  generating: false,
  notesError: '',
  notesProgress: '',
};

// --- Formatting -----------------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)} sec`;
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function defaultTitle() {
  return `Lecture – ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
}

function slugify(s) {
  return s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'lecture';
}

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function keptSegments(lecture) {
  return (lecture?.segments ?? []).filter((s) => !s.chatter);
}

function elapsed() {
  return state.accumulated + (state.status === 'recording' ? performance.now() - state.runStart : 0);
}

// --- Notices ----------------------------------------------------------------------

function showNotice(message, kind = 'error') {
  els.notice.textContent = message;
  els.notice.hidden = false;
  state.noticeKind = kind;
}

function hideNotice(kind) {
  if (kind && state.noticeKind !== kind) return;
  els.notice.hidden = true;
  state.noticeKind = null;
}

// --- Microphone and language pickers ------------------------------------------------

async function populateMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
  const wanted = els.micSelect.value || loadPrefs().micId || '';
  els.micSelect.replaceChildren(
    new Option('Default microphone', ''),
    ...devices.map((d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId)),
  );
  els.micSelect.value = devices.some((d) => d.deviceId === wanted) ? wanted : '';
}

function populateLanguages() {
  const langs = [...LANGUAGES];
  const browserLang = navigator.language;
  if (browserLang && !langs.some(([code]) => code === browserLang)) langs.push([browserLang, browserLang]);
  els.langSelect.replaceChildren(...langs.map(([code, label]) => new Option(label, code)));
  const saved = loadPrefs().lang;
  els.langSelect.value = [saved, browserLang, 'en-US'].find((c) => c && langs.some(([code]) => code === c));
}

// --- Recording --------------------------------------------------------------------

function pickMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showNotice('This browser can’t record audio here. Use a recent Chrome, Edge, Safari or Firefox over https:// or http://localhost.');
    return;
  }
  hideNotice();

  if (state.status === 'stopped') resetToIdle();

  let stream;
  try {
    const deviceId = els.micSelect.value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const messages = {
      NotAllowedError: 'Microphone access was blocked. Allow it from the icon in the address bar, then try again.',
      NotFoundError: 'No microphone was found. Plug one in and try again.',
      OverconstrainedError: 'The selected microphone isn’t available. Choose another one.',
      NotReadableError: 'The microphone is in use by another app.',
    };
    showNotice(messages[err.name] || `Couldn’t open the microphone: ${err.message}`);
    return;
  }
  populateMics(); // device labels become available once permission is granted

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    showNotice(`Couldn’t start the recorder: ${err.message}`);
    return;
  }

  const typedTitle = els.title.value.trim();
  state.lecture = {
    id: crypto.randomUUID(),
    title: typedTitle || defaultTitle(),
    titleEdited: Boolean(typedTitle) && typedTitle !== els.title.dataset.default,
    createdAt: Date.now(),
    duration: 0,
    lang: els.langSelect.value,
    engine: els.engineSelect.value,
    segments: [],
    notes: null,
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
    audioBlob: null,
    status: 'recording',
  };
  els.title.value = state.lecture.title;

  state.stream = stream;
  state.recorder = recorder;
  state.chunks = [];
  state.accumulated = 0;
  state.runStart = performance.now();
  state.recognitionBlocked = false;
  state.recognitionFailures = 0;
  state.notesError = '';
  state.status = 'recording';

  recorder.ondataavailable = (e) => {
    if (e.data.size) state.chunks.push(e.data);
  };
  recorder.onstop = finishRecording;
  recorder.start(1000);

  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (state.status === 'recording' || state.status === 'paused') {
      showNotice('The microphone was disconnected, so the recording was stopped and saved.');
      stopRecording();
    }
  });

  clearPlayback();
  renderTranscript();
  renderNotes();
  startVisualizer(stream);
  state.timerId = setInterval(updateTimer, 250);
  state.autosaveId = setInterval(autosave, 30000);
  if (state.lecture.engine === 'whisper') startWhisper();
  else startRecognition();
  requestWakeLock();
  updateUI();
  renderLibrary();
}

function togglePause() {
  if (state.status === 'recording') {
    state.recorder.pause();
    state.accumulated += performance.now() - state.runStart;
    state.status = 'paused';
    stopRecognition();
  } else if (state.status === 'paused') {
    state.recorder.resume();
    state.runStart = performance.now();
    state.status = 'recording';
    if (state.lecture.engine !== 'whisper') startRecognition();
  }
  updateUI();
  renderInterim();
}

function stopRecording() {
  if (state.status !== 'recording' && state.status !== 'paused') return;
  if (state.status === 'recording') state.accumulated += performance.now() - state.runStart;
  state.status = 'stopping';
  stopRecognition();
  clearInterval(state.timerId);
  clearInterval(state.autosaveId);
  releaseWakeLock();
  stopVisualizer();
  state.recorder.stop(); // calls finishRecording once the last chunk is flushed
  state.stream.getTracks().forEach((t) => t.stop());
  updateUI();
}

async function finishRecording() {
  const lecture = state.lecture;
  if (state.whisper) {
    // Wait for the last chunks so the saved transcript (and the notes) are complete.
    await state.whisper.drain();
    state.whisper = null;
    renderInterim();
  }
  lecture.audioBlob = new Blob(state.chunks, { type: lecture.mimeType });
  lecture.duration = Math.round(state.accumulated);
  lecture.status = 'done';
  state.chunks = [];
  state.recorder = null;
  state.stream = null;
  state.status = 'stopped';

  await persist(lecture);
  showPlayback(lecture);
  updateTimer();
  updateUI();
  renderLibrary();

  if (lecture.segments.length && els.autoNotes.checked && getApiKey()) runNotes();
}

function autosave() {
  const lecture = state.lecture;
  if (!lecture || (state.status !== 'recording' && state.status !== 'paused')) return;
  persist({
    ...lecture,
    duration: Math.round(elapsed()),
    audioBlob: new Blob(state.chunks, { type: lecture.mimeType }),
  }).then(renderLibrary);
}

// --- Live transcription ------------------------------------------------------------

function startRecognition() {
  if (!SpeechRecognition || state.recognitionBlocked) return;

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = state.lecture.lang;

  rec.onresult = (e) => {
    if (state.recognition !== rec) return;
    state.recognitionFailures = 0;
    hideNotice('network');
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result[0].transcript;
      if (state.utteranceStart === null && text.trim()) state.utteranceStart = elapsed();
      if (result.isFinal) commitSegment(text);
      else interim += text;
    }
    state.interim = interim.trim();
    renderInterim();
  };

  rec.onerror = (e) => {
    if (state.recognition !== rec) return;
    switch (e.error) {
      case 'no-speech':
      case 'aborted':
        break;
      case 'not-allowed':
      case 'service-not-allowed':
        state.recognitionBlocked = true;
        showNotice('The browser blocked live transcription. Audio is still being recorded.');
        break;
      case 'language-not-supported':
        state.recognitionBlocked = true;
        showNotice('Live transcription isn’t available for this language. Audio is still being recorded.');
        break;
      case 'network':
        state.recognitionFailures++;
        showNotice('Transcription lost its connection to the speech service. Retrying… Audio is still being recorded.', 'network');
        break;
      default:
        state.recognitionFailures++;
        console.warn('Speech recognition error:', e.error);
    }
  };

  // Recognition ends on its own after silences or errors; keep it going while recording.
  rec.onend = () => {
    if (state.recognition !== rec || state.status !== 'recording' || state.recognitionBlocked) return;
    if (state.interim) {
      commitSegment(state.interim);
      state.interim = '';
      renderInterim();
    }
    const delay = Math.min(250 * 2 ** state.recognitionFailures, 10000);
    setTimeout(() => {
      if (state.recognition !== rec || state.status !== 'recording') return;
      try {
        rec.start();
      } catch (err) {
        console.warn(err);
      }
    }, delay);
  };

  state.recognition = rec;
  try {
    rec.start();
  } catch (err) {
    console.warn(err);
  }
}

// --- On-device transcription (Whisper) ---------------------------------------------

async function startWhisper() {
  const lecture = state.lecture;
  const ctx = state.audioCtx;
  if (!ctx || !state.audioSource) {
    showNotice('On-device transcription couldn’t access the audio. Audio is still being recorded.');
    return;
  }
  loadWhisper(updateModelStatus).catch(() => {}); // failures are reported through updateModelStatus

  state.whisper = new WhisperSession({
    language: lecture.lang,
    inputRate: ctx.sampleRate,
    onSegment: (text, t) => addSegment(lecture, text, t),
    onBacklog: (count) => {
      state.whisperBacklog = count;
      renderInterim();
    },
    onError: (message) => {
      if (state.lecture === lecture) showNotice(`On-device transcription failed (${message}). Audio is still being recorded.`);
    },
  });
  const session = state.whisper;
  renderInterim();

  try {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
  } catch (err) {
    showNotice(`On-device transcription couldn’t start (${err.message}). Audio is still being recorded.`);
    return;
  }
  if (state.whisper !== session || ctx.state === 'closed') return;

  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e) => {
    if (state.status === 'recording' && state.whisper === session) session.push(e.data, elapsed());
  };
  const mute = ctx.createGain(); // keeps the node pulled by the graph without playing anything
  mute.gain.value = 0;
  state.audioSource.connect(node).connect(mute).connect(ctx.destination);
}

function updateModelStatus({ phase, percent, message }) {
  if (phase === 'download') {
    state.modelStatus = `Downloading speech model… ${percent}%`;
  } else if (phase === 'ready') {
    state.modelStatus = '';
    state.modelReady = true;
  } else if (phase === 'error') {
    state.modelStatus = '';
    if (state.whisper) showNotice(`Couldn’t load the speech model (${message}). Audio is still being recorded.`);
  }
  updateEngineHint(phase === 'error' ? `Couldn’t load the speech model: ${message}` : '');
  renderInterim();
}

function updateEngineHint(override = '') {
  const hints = {
    browser: 'Words appear as they’re spoken. The browser sends audio to its speech service.',
    whisper: state.modelReady
      ? 'Speech model ready. Audio stays on this device; text appears a few seconds behind.'
      : 'Audio stays on this device; text appears a few seconds behind. First use downloads an ~80 MB model.',
  };
  els.engineHint.textContent = override || state.modelStatus || hints[els.engineSelect.value] || '';
}

function populateEngines() {
  const options = [];
  if (SpeechRecognition) options.push(new Option('Browser speech service (live)', 'browser'));
  options.push(new Option('On-device Whisper (private)', 'whisper'));
  els.engineSelect.replaceChildren(...options);
  const saved = loadPrefs().engine;
  els.engineSelect.value = options.some((o) => o.value === saved) ? saved : options[0].value;
  updateEngineHint();
}

function stopRecognition() {
  state.whisper?.cut(); // send buffered audio now rather than waiting for a pause
  const rec = state.recognition;
  state.recognition = null;
  if (state.interim) commitSegment(state.interim);
  state.interim = '';
  renderInterim();
  if (rec) {
    try {
      rec.abort();
    } catch {
      // already stopped
    }
  }
}

function commitSegment(rawText) {
  const t = state.utteranceStart ?? elapsed();
  state.utteranceStart = null;
  addSegment(state.lecture, rawText, t);
}

function addSegment(lecture, rawText, t) {
  const text = rawText.trim();
  if (!text || !lecture) return;
  const segment = { t: Math.round(t), text: text[0].toLocaleUpperCase() + text.slice(1) };
  lecture.segments.push(segment);
  if (state.lecture !== lecture) return;

  const nearBottom = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 80;
  els.segments.append(segmentEl(segment, state.lecture.segments.length - 1));
  if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
  updateTranscriptMeta();
}

// --- Level visualizer --------------------------------------------------------------

function startVisualizer(stream) {
  try {
    state.audioCtx = new AudioContext();
    state.audioCtx.resume().catch(() => {});
    state.audioSource = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 1024;
    state.audioSource.connect(state.analyser);
  } catch (err) {
    console.warn('Visualizer unavailable:', err);
    return;
  }
  state.levels = [];
  const buffer = new Float32Array(state.analyser.fftSize);
  let lastPush = 0;

  const frame = (now) => {
    if (!state.analyser) return;
    if (state.status === 'recording' && now - lastPush > 60) {
      state.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      state.levels.push(Math.min(1, Math.sqrt(sum / buffer.length) * 4));
      lastPush = now;
    }
    drawLevels();
    state.rafId = requestAnimationFrame(frame);
  };
  state.rafId = requestAnimationFrame(frame);
}

function stopVisualizer() {
  cancelAnimationFrame(state.rafId);
  state.analyser = null;
  state.audioSource = null;
  state.audioCtx?.close().catch(() => {}); // Firefox rejects if the context is mid-state-change
  state.audioCtx = null;
}

function drawLevels() {
  const canvas = els.viz;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const barW = 3;
  const gap = 2;
  const count = Math.floor(w / (barW + gap));
  const levels = state.levels.slice(-count);
  if (state.levels.length > count * 2) state.levels = levels;
  const mid = h / 2 + 8;
  const maxH = h - 64;

  ctx.fillStyle = styles.getPropertyValue(state.status === 'paused' ? '--muted' : '--viz').trim();
  const offset = count - levels.length;
  for (let i = 0; i < count; i++) {
    const level = levels[i - offset] ?? 0;
    const barH = Math.max(2, level * maxH);
    ctx.globalAlpha = i < offset ? 0.25 : 0.35 + 0.65 * ((i - offset) / Math.max(1, levels.length));
    ctx.fillRect(i * (barW + gap), mid - barH / 2, barW, barH);
  }
  ctx.globalAlpha = 1;
}

// --- Wake lock ------------------------------------------------------------------------

async function requestWakeLock() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    state.wakeLock = lock;
    lock.addEventListener('release', () => {
      if (state.wakeLock === lock) state.wakeLock = null;
    });
  } catch {
    // Not supported or not allowed; recording still works.
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

// --- Playback & downloads ---------------------------------------------------------------

function clearPlayback() {
  els.player.pause();
  els.player.removeAttribute('src');
  els.player.load();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = null;
  els.playback.hidden = true;
}

function showPlayback(lecture) {
  clearPlayback();
  if (!lecture.audioBlob?.size) return;
  state.audioUrl = URL.createObjectURL(lecture.audioBlob);
  els.player.src = state.audioUrl;
  els.playback.hidden = false;
}

function audioExtension(mimeType) {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function transcriptText(lecture) {
  const kept = keptSegments(lecture);
  const removed = lecture.segments.length - kept.length;
  const header = [
    lecture.title,
    `${formatDate(lecture.createdAt)} · ${formatDuration(lecture.duration || elapsed())}`,
    removed ? `(${removed} background chatter line${removed === 1 ? '' : 's'} removed)` : '',
  ].filter(Boolean).join('\n');
  return `${header}\n\n${kept.map((s) => `[${formatClock(s.t)}] ${s.text}`).join('\n')}\n`;
}

function notesText(lecture) {
  const { notes } = lecture;
  return `# ${lecture.title}\n\n_${formatDate(lecture.createdAt)} · ${formatDuration(lecture.duration)}_\n\n` +
    `> ${notes.summary}\n\n${notes.markdown}\n`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = label; }, 1500);
  } catch {
    showNotice('Couldn’t copy to the clipboard.');
  }
}

// --- Transcript rendering -----------------------------------------------------------

function segmentEl(segment, index) {
  const row = document.createElement('div');
  row.className = 'seg';
  row.dataset.index = index;
  row.classList.toggle('chatter', Boolean(segment.chatter));

  const ts = document.createElement('button');
  ts.type = 'button';
  ts.className = 'ts';
  ts.textContent = formatClock(segment.t);
  ts.title = 'Play from here';

  const text = document.createElement('p');
  text.className = 'text';
  text.textContent = segment.text;
  try {
    text.contentEditable = 'plaintext-only';
  } catch {
    text.contentEditable = 'true'; // older browsers reject plaintext-only
  }
  text.spellcheck = false;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'seg-toggle';
  toggle.textContent = segment.chatter ? 'Restore' : 'Remove';
  toggle.title = segment.chatter ? 'Put this line back in the transcript' : 'Mark as background chatter';

  row.append(ts, text, toggle);
  return row;
}

function renderTranscript() {
  const segments = state.lecture?.segments ?? [];
  els.segments.replaceChildren(...segments.map(segmentEl));
  renderInterim();
  updateTranscriptMeta();
}

function whisperActivity() {
  if (!state.whisper) return '';
  if (state.modelStatus) return state.modelStatus;
  const n = state.whisperBacklog;
  if (n) return `Transcribing…${n > 1 ? ` (${n} chunks queued)` : ''}`;
  return state.status === 'recording' ? 'Listening…' : '';
}

function renderInterim() {
  els.interim.textContent = state.interim || whisperActivity();
  els.emptyState.hidden = Boolean(state.lecture?.segments.length || els.interim.textContent);
}

function updateTranscriptMeta() {
  const lecture = state.lecture;
  const kept = keptSegments(lecture);
  const removed = (lecture?.segments.length ?? 0) - kept.length;
  const words = kept.reduce((n, s) => n + countWords(s.text), 0);
  els.wordCount.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}` +
    (removed ? ` · ${removed} chatter line${removed === 1 ? '' : 's'} removed` : '');
  els.chatterToggle.hidden = !removed;
  els.chatterToggle.textContent = state.showChatter ? 'Hide removed' : `Show removed (${removed})`;
  els.transcript.classList.toggle('show-chatter', state.showChatter);
  els.copyBtn.disabled = els.downloadTxtBtn.disabled = !kept.length;
  els.emptyState.hidden = Boolean(lecture?.segments.length || els.interim.textContent);
  updateNotesControls();
}

let saveTimer = 0;
function scheduleSave() {
  const lecture = state.lecture;
  if (!lecture || lecture.status !== 'done') return; // recordings in progress are covered by autosave
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(lecture).then(renderLibrary), 600);
}

els.segments.addEventListener('click', (e) => {
  const row = e.target.closest('.seg');
  if (!row || !state.lecture) return;
  const segment = state.lecture.segments[Number(row.dataset.index)];

  if (e.target.closest('.ts')) {
    if (!state.audioUrl) return;
    els.player.currentTime = segment.t / 1000;
    els.player.play();
  } else if (e.target.closest('.seg-toggle')) {
    segment.chatter = !segment.chatter;
    row.replaceWith(segmentEl(segment, Number(row.dataset.index)));
    updateTranscriptMeta();
    scheduleSave();
  }
});

els.segments.addEventListener('input', (e) => {
  const row = e.target.closest('.seg');
  if (!row || !state.lecture) return;
  state.lecture.segments[Number(row.dataset.index)].text = e.target.textContent.trim();
  updateTranscriptMeta();
  scheduleSave();
});

els.segments.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('text')) {
    e.preventDefault();
    e.target.blur();
  }
});

// --- Notes -----------------------------------------------------------------------------

function getApiKey() {
  return (loadPrefs().apiKey || '').trim();
}

function updateNotesControls() {
  const lecture = state.lecture;
  const canGenerate = lecture?.status === 'done' && lecture.segments.length > 0 && !state.generating;
  els.generateBtn.disabled = !canGenerate;
  els.generateBtn.textContent = state.generating ? 'Generating…' : lecture?.notes ? 'Regenerate' : 'Generate notes';
  els.copyNotesBtn.disabled = els.downloadNotesBtn.disabled = !lecture?.notes;
}

function renderNotes() {
  const lecture = state.lecture;
  const notes = lecture?.notes;
  const body = [];

  if (state.notesError) {
    const p = document.createElement('p');
    p.className = 'notes-error';
    p.textContent = state.notesError;
    body.push(p);
  }

  if (notes) {
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.innerHTML = '<span class="summary-label">Summary</span>';
    summary.append(notes.summary);
    const md = document.createElement('div');
    md.className = 'markdown';
    md.innerHTML = renderMarkdown(notes.markdown); // renderer escapes all text
    body.push(summary, md);
    els.notesStatus.textContent = `Generated ${formatDate(notes.generatedAt)}`;
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const msg = document.createElement('p');
    const sub = document.createElement('p');
    sub.className = 'muted';
    if (state.generating) {
      msg.textContent = 'Claude is reading the transcript…';
      sub.textContent = 'Long lectures can take a minute or two.';
    } else if (!getApiKey()) {
      msg.textContent = 'Add your Anthropic API key to turn transcripts into study notes.';
      sub.textContent = 'Claude summarizes the lecture, organizes the notes, and removes background chatter from students.';
    } else if (lecture?.status === 'done' && lecture.segments.length) {
      msg.textContent = 'No notes yet for this lecture.';
      sub.textContent = 'Press Generate notes to summarize it and remove background chatter.';
    } else {
      msg.textContent = 'Notes appear here after you stop recording.';
      sub.textContent = 'Claude summarizes the lecture, organizes the notes, and removes background chatter from students.';
    }
    empty.append(msg, sub);
    body.push(empty);
    els.notesStatus.textContent = '';
  }

  if (state.generating) els.notesStatus.textContent = state.notesProgress || 'Sending transcript to Claude…';
  els.notesBody.replaceChildren(...body);
  updateNotesControls();
}

async function runNotes() {
  const lecture = state.lecture;
  if (!lecture || state.generating || !lecture.segments.length) return;
  if (!getApiKey()) {
    els.settings.open = true;
    els.apiKey.focus();
    return;
  }

  state.generating = true;
  state.notesError = '';
  state.notesProgress = '';
  renderNotes();

  try {
    const result = await generateNotes({
      apiKey: getApiKey(),
      title: lecture.title,
      segments: lecture.segments,
      onProgress: (chars) => {
        state.notesProgress = `Writing notes… ${chars.toLocaleString()} characters`;
        if (state.lecture === lecture) els.notesStatus.textContent = state.notesProgress;
      },
    });

    const chatter = new Set(result.chatterIds);
    lecture.segments.forEach((s, i) => { s.chatter = chatter.has(i); });
    lecture.notes = {
      summary: result.summary,
      markdown: result.markdown,
      model: result.model,
      generatedAt: Date.now(),
    };
    if (!lecture.titleEdited && result.title) lecture.title = result.title;
    await persist(lecture);
  } catch (err) {
    console.error(err);
    if (state.lecture === lecture) state.notesError = err.message || 'Something went wrong generating notes.';
  } finally {
    state.generating = false;
    state.notesProgress = '';
  }

  if (state.lecture === lecture) {
    els.title.value = lecture.title;
    renderTranscript();
  }
  renderNotes();
  renderLibrary();
}

// --- Library ------------------------------------------------------------------------------

async function renderLibrary() {
  let lectures;
  try {
    lectures = await db.all();
  } catch {
    lectures = [];
  }
  lectures.sort((a, b) => b.createdAt - a.createdAt);
  els.libraryCount.textContent = lectures.length;
  els.libraryEmpty.hidden = lectures.length > 0;
  const live = state.status === 'recording' || state.status === 'paused' || state.status === 'stopping';

  els.libraryList.replaceChildren(...lectures.map((lecture) => {
    const li = document.createElement('li');
    li.className = 'lecture-item';
    li.classList.toggle('active', lecture.id === state.lecture?.id);

    const h3 = document.createElement('h3');
    h3.textContent = lecture.title;
    h3.title = lecture.title;

    const meta = document.createElement('div');
    meta.className = 'lecture-meta';
    const words = keptSegments(lecture).reduce((n, s) => n + countWords(s.text), 0);
    for (const text of [formatDate(lecture.createdAt), formatDuration(lecture.duration), `${words.toLocaleString()} words`]) {
      const span = document.createElement('span');
      span.textContent = text;
      meta.append(span);
    }
    const badge = (text, cls = '') => {
      const b = document.createElement('span');
      b.className = `badge ${cls}`;
      b.textContent = text;
      meta.append(b);
    };
    if (lecture.status === 'recording') badge('Recording');
    if (lecture.recovered) badge('Recovered');
    if (lecture.notes) badge('Notes', 'badge-ok');

    const preview = document.createElement('p');
    preview.className = 'lecture-preview';
    preview.textContent = lecture.notes?.summary || keptSegments(lecture).slice(0, 6).map((s) => s.text).join(' ') || 'No transcript.';

    const actions = document.createElement('div');
    actions.className = 'lecture-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-secondary';
    open.textContent = 'Open';
    open.disabled = live;
    open.addEventListener('click', () => openLecture(lecture.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-danger';
    del.textContent = 'Delete';
    del.disabled = live && lecture.id === state.lecture?.id;
    del.addEventListener('click', () => deleteLecture(lecture));
    actions.append(open, del);

    li.append(h3, meta, preview, actions);
    return li;
  }));
}

async function openLecture(id) {
  if (state.status === 'recording' || state.status === 'paused' || state.status === 'stopping') return;
  const lecture = await db.get(id);
  if (!lecture) return;
  hideNotice();
  state.lecture = lecture;
  state.status = 'stopped';
  state.accumulated = lecture.duration;
  state.showChatter = false;
  state.notesError = '';
  els.title.value = lecture.title;
  showPlayback(lecture);
  renderTranscript();
  renderNotes();
  updateTimer();
  updateUI();
  renderLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteLecture(lecture) {
  if (!confirm(`Delete “${lecture.title}”? This removes its recording, transcript and notes.`)) return;
  await db.remove(lecture.id);
  if (state.lecture?.id === lecture.id) resetToIdle();
  renderLibrary();
}

function resetToIdle() {
  state.lecture = null;
  state.status = 'idle';
  state.accumulated = 0;
  state.interim = '';
  state.showChatter = false;
  state.notesError = '';
  els.title.dataset.default = defaultTitle();
  els.title.value = els.title.dataset.default;
  clearPlayback();
  state.levels = [];
  drawLevels();
  renderTranscript();
  renderNotes();
  updateTimer();
  updateUI();
  renderLibrary();
}

// Marks any lecture left mid-recording by a crash or closed tab as finished.
async function recoverInterrupted() {
  try {
    const lectures = await db.all();
    await Promise.all(lectures
      .filter((l) => l.status === 'recording')
      .map((l) => db.put({ ...l, status: 'done', recovered: true })));
  } catch (err) {
    console.warn('Recovery check failed:', err);
  }
}

// --- UI state ----------------------------------------------------------------------------

function updateTimer() {
  els.timer.textContent = formatTimer(elapsed());
}

function updateUI() {
  const s = state.status;
  const live = s === 'recording' || s === 'paused' || s === 'stopping';
  els.recordBtn.disabled = live;
  els.recordBtn.querySelector('.label').textContent = s === 'stopped' ? 'Record new lecture' : 'Start recording';
  els.pauseBtn.disabled = s !== 'recording' && s !== 'paused';
  els.pauseBtn.textContent = s === 'paused' ? 'Resume' : 'Pause';
  els.stopBtn.disabled = s !== 'recording' && s !== 'paused';
  els.micSelect.disabled = els.langSelect.disabled = els.engineSelect.disabled = live;
  els.statusPill.dataset.status = s;
  els.statusPill.textContent = STATUS_LABELS[s];
  els.newBtn.hidden = s !== 'stopped';
  document.title = s === 'recording' ? '● Recording – LectureListen' : 'LectureListen';
  updateNotesControls();
}

// --- Wiring ------------------------------------------------------------------------------

els.recordBtn.addEventListener('click', startRecording);
els.pauseBtn.addEventListener('click', togglePause);
els.stopBtn.addEventListener('click', stopRecording);
els.newBtn.addEventListener('click', resetToIdle);

els.downloadAudioBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (l?.audioBlob) download(l.audioBlob, `${slugify(l.title)}.${audioExtension(l.mimeType)}`);
});
els.copyBtn.addEventListener('click', () => state.lecture && copyText(transcriptText(state.lecture), els.copyBtn));
els.downloadTxtBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (l) download(new Blob([transcriptText(l)], { type: 'text/plain' }), `${slugify(l.title)}-transcript.txt`);
});
els.chatterToggle.addEventListener('click', () => {
  state.showChatter = !state.showChatter;
  updateTranscriptMeta();
});

els.generateBtn.addEventListener('click', runNotes);
els.copyNotesBtn.addEventListener('click', () => state.lecture?.notes && copyText(notesText(state.lecture), els.copyNotesBtn));
els.downloadNotesBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (l?.notes) download(new Blob([notesText(l)], { type: 'text/markdown' }), `${slugify(l.title)}-notes.md`);
});

els.saveKeyBtn.addEventListener('click', () => {
  const key = els.apiKey.value.trim();
  if (!key) return;
  savePrefs({ apiKey: key });
  els.apiKey.value = '';
  els.apiKey.placeholder = 'Key saved ✓';
  els.settings.open = false;
  renderNotes();
});
els.apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.saveKeyBtn.click();
});
els.clearKeyBtn.addEventListener('click', () => {
  savePrefs({ apiKey: '' });
  els.apiKey.value = '';
  els.apiKey.placeholder = 'sk-ant-…';
  renderNotes();
});
els.autoNotes.addEventListener('change', () => savePrefs({ autoNotes: els.autoNotes.checked }));

els.title.addEventListener('input', () => {
  const lecture = state.lecture;
  if (!lecture) return;
  lecture.title = els.title.value.trim() || defaultTitle();
  lecture.titleEdited = true;
  scheduleSave();
});

els.micSelect.addEventListener('change', () => savePrefs({ micId: els.micSelect.value }));
els.langSelect.addEventListener('change', () => savePrefs({ lang: els.langSelect.value }));
els.engineSelect.addEventListener('change', () => {
  savePrefs({ engine: els.engineSelect.value });
  updateEngineHint();
  if (els.engineSelect.value === 'whisper') loadWhisper(updateModelStatus).catch(() => {}); // start the download early
});
navigator.mediaDevices?.addEventListener?.('devicechange', populateMics);

document.addEventListener('visibilitychange', () => {
  const live = state.status === 'recording' || state.status === 'paused';
  if (document.visibilityState === 'visible' && live && !state.wakeLock) requestWakeLock();
});

window.addEventListener('beforeunload', (e) => {
  if (state.status === 'recording' || state.status === 'paused' || state.status === 'stopping' || state.generating) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('resize', () => {
  if (!state.analyser) drawLevels();
});

document.addEventListener('keydown', (e) => {
  // Space toggles pause while recording, unless typing somewhere.
  if (e.code !== 'Space' || e.target.closest('input, select, textarea, [contenteditable], button')) return;
  if (state.status === 'recording' || state.status === 'paused') {
    e.preventDefault();
    togglePause();
  }
});

// --- Init ----------------------------------------------------------------------------------

async function init() {
  const prefs = loadPrefs();
  els.autoNotes.checked = prefs.autoNotes ?? true;
  if (prefs.apiKey) els.apiKey.placeholder = 'Key saved ✓';

  if (location.protocol !== 'file:' && !window.MediaRecorder) {
    els.banner.hidden = false;
    els.banner.textContent = 'This browser can’t record audio. Use a recent Firefox, Chrome, Edge or Safari.';
  }

  populateEngines();

  populateLanguages();
  populateMics();
  resetToIdle();
  await recoverInterrupted();
  renderLibrary();
}

init();
