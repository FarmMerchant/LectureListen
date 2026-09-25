import { generateNotes, listModels, renderMarkdown, typesetMath, PROVIDERS } from './notes.js';
import { parseTranscript, IMPORT_EXTENSIONS } from './transcript-import.js';
import { loadWhisper, WhisperSession } from './whisper.js';

const $ = (id) => document.getElementById(id);

const els = {
  banner: $('banner'),
  title: $('title'),
  micSelect: $('micSelect'),
  langSelect: $('langSelect'),
  engineSelect: $('engineSelect'),
  engineHint: $('engineHint'),
  recSettingsSummary: $('recSettingsSummary'),
  viz: $('viz'),
  statusPill: $('statusPill'),
  timer: $('timer'),
  recordBtn: $('recordBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  notice: $('notice'),
  playback: $('playback'),
  player: $('player'),
  partTabs: $('partTabs'),
  continueBtn: $('continueBtn'),
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
  providerSelect: $('providerSelect'),
  providerSummary: $('providerSummary'),
  providerHelp: $('providerHelp'),
  modelSelect: $('modelSelect'),
  modelInput: $('modelInput'),
  baseUrlField: $('baseUrlField'),
  baseUrlInput: $('baseUrlInput'),
  apiKeyLabel: $('apiKeyLabel'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
  emptyImportBtn: $('emptyImportBtn'),
  dropOverlay: $('dropOverlay'),
  apiKey: $('apiKey'),
  saveKeyBtn: $('saveKeyBtn'),
  clearKeyBtn: $('clearKeyBtn'),
  autoNotes: $('autoNotes'),
  notesBody: $('notesBody'),
  libraryCount: $('libraryCount'),
  selectBtn: $('selectBtn'),
  mergeBar: $('mergeBar'),
  mergeCount: $('mergeCount'),
  mergeBtn: $('mergeBtn'),
  removeOriginals: $('removeOriginals'),
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
  partStart: 0, // lecture time (ms) where this recording session's audio begins
  playbackParts: [],
  partIndex: 0,
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
  generatingId: null, // lecture currently being summarized
  selecting: false, // library is in "select to merge" mode
  selectedIds: new Set(),
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
  updateRecSettingsSummary();
}

// One-line summary shown on the collapsed "Input settings" row.
function updateRecSettingsSummary() {
  const label = (select) => select.selectedOptions[0]?.textContent || '';
  const engine = els.engineSelect.value === 'whisper' ? 'On-device Whisper' : els.engineSelect.value ? 'Browser speech' : '';
  els.recSettingsSummary.textContent = [label(els.micSelect), label(els.langSelect), engine].filter(Boolean).join(' · ');
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
  // Ogg first: Firefox's WebM recordings have no seek index, so timestamps couldn't
  // jump into them. Chrome and Edge can't record Ogg and fall through to WebM.
  const types = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

// Audio is stored as one part per recording session, because separate
// MediaRecorder files can't simply be joined. Older lectures have one audioBlob.
function audioPartsOf(lecture) {
  if (lecture?.audioParts?.length) return lecture.audioParts;
  if (lecture?.audioBlob?.size) {
    return [{ blob: lecture.audioBlob, mimeType: lecture.mimeType, start: 0, duration: lecture.duration }];
  }
  return [];
}

function canContinue(lecture) {
  return state.status === 'stopped' && lecture?.status === 'done' && !isSummarizing(lecture.id);
}

/** @param {{ resume?: boolean }} [options] resume: keep recording into the lecture on screen */
async function startRecording({ resume = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showNotice('This browser can’t record audio here. Use a recent Chrome, Edge, Safari or Firefox over https:// or http://localhost.');
    return;
  }
  hideNotice();

  const continuing = resume && canContinue(state.lecture) ? state.lecture : null;
  if (state.status === 'stopped' && !continuing) resetToIdle();

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

  const recordedType = recorder.mimeType || mimeType || 'audio/webm';
  if (continuing) {
    // Pick up the timeline where the lecture left off. Imported transcripts only
    // know when their last line started, so leave a small gap after it.
    const offset = (continuing.duration || 0) + (continuing.source === 'import' && continuing.duration ? 5000 : 0);
    continuing.audioParts = audioPartsOf(continuing);
    continuing.audioBlob = null;
    continuing.breaks = [...(continuing.breaks || []), { t: offset, at: Date.now() }];
    continuing.continuedAt = Date.now();
    continuing.lang = els.langSelect.value;
    continuing.engine = els.engineSelect.value;
    continuing.mimeType = recordedType;
    continuing.status = 'recording';
    state.accumulated = offset;
  } else {
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
      mimeType: recordedType,
      audioParts: [],
      status: 'recording',
    };
    els.title.value = state.lecture.title;
    state.accumulated = 0;
  }

  state.stream = stream;
  state.recorder = recorder;
  state.chunks = [];
  state.partStart = state.accumulated;
  state.partRecordedAt = Date.now();
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
  lecture.audioParts = [...audioPartsOf(lecture), currentPart(lecture, state.accumulated)];
  lecture.audioBlob = null;
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

  if (lecture.segments.length && els.autoNotes.checked && aiReady()) queueNotes(lecture);
}

function autosave() {
  const lecture = state.lecture;
  if (!lecture || (state.status !== 'recording' && state.status !== 'paused')) return;
  const now = elapsed();
  persist({
    ...lecture,
    duration: Math.round(now),
    audioParts: [...audioPartsOf(lecture), currentPart(lecture, now)],
    audioBlob: null,
  }).then(renderLibrary);
}

// The audio recorded in this session so far.
function currentPart(lecture, endMs) {
  return {
    blob: new Blob(state.chunks, { type: lecture.mimeType }),
    mimeType: lecture.mimeType,
    start: Math.round(state.partStart),
    duration: Math.round(endMs - state.partStart),
    recordedAt: state.partRecordedAt,
  };
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
  // Bars sit between the status pill (top) and the timer (bottom).
  const mid = h * 0.44;
  const maxH = h - 100;

  if (state.status === 'paused') {
    ctx.fillStyle = styles.getPropertyValue('--muted').trim();
  } else {
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, styles.getPropertyValue('--viz-2').trim() || '#38d6f5');
    gradient.addColorStop(1, styles.getPropertyValue('--viz').trim() || '#8b8cff');
    ctx.fillStyle = gradient;
  }
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
  state.playbackParts = [];
  els.partTabs.replaceChildren();
  els.playback.hidden = true;
}

function showPlayback(lecture) {
  clearPlayback();
  const parts = audioPartsOf(lecture).filter((p) => p.blob?.size);
  if (!parts.length) return;
  state.playbackParts = parts;
  if (parts.length > 1) {
    els.partTabs.replaceChildren(...parts.map((part, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'part-tab';
      b.textContent = `Part ${i + 1} · ${formatClock(part.start)}`;
      b.title = part.recordedAt ? `Recorded ${formatDate(part.recordedAt)}` : '';
      b.addEventListener('click', () => loadPart(i));
      return b;
    }));
  }
  loadPart(0);
  els.playback.hidden = false;
  els.downloadAudioBtn.textContent = parts.length > 1 ? `Download audio (${parts.length} parts)` : 'Download audio';
}

function loadPart(index, seekMs = 0, play = false) {
  const part = state.playbackParts[index];
  if (!part) return;
  if (index !== state.partIndex || !state.audioUrl) {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(part.blob);
    els.player.src = state.audioUrl;
    state.partIndex = index;
  }
  [...els.partTabs.children].forEach((b, i) => b.classList.toggle('active', i === index));
  const seek = () => {
    if (seekMs) {
      const target = seekMs / 1000;
      els.player.currentTime = target;
      // Recordings without a seek index can ignore an early seek; apply it again once data arrives.
      els.player.addEventListener('canplay', () => {
        if (Math.abs(els.player.currentTime - target) > 1.5) els.player.currentTime = target;
      }, { once: true });
    }
    if (play) els.player.play().catch(() => {});
  };
  if (els.player.readyState >= 1) seek();
  else els.player.addEventListener('loadedmetadata', seek, { once: true });
}

// Plays the lecture from a timeline position, switching to the part that contains it.
function playAt(ms) {
  const parts = state.playbackParts;
  let index = 0;
  parts.forEach((p, i) => { if (p.start <= ms) index = i; });
  loadPart(index, Math.max(0, ms - parts[index].start), true);
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
    lectureMeta(lecture),
    removed ? `(${removed} background chatter line${removed === 1 ? '' : 's'} removed)` : '',
  ].filter(Boolean).join('\n');
  const marks = breakPositions(lecture).sort((a, b) => a.at - b.at || a.order - b.order);
  const lines = [];
  lecture.segments.forEach((s, i) => {
    while (marks.length && marks[0].at <= i) lines.push(`— ${breakLabel(marks.shift().pause)} —`);
    if (!s.chatter) lines.push(s.t == null ? s.text : `[${formatClock(s.t)}] ${s.text}`);
  });
  return `${header}\n\n${lines.join(kept.some((s) => s.t == null) ? '\n\n' : '\n')}\n`;
}

function lectureMeta(lecture) {
  const duration = lecture.duration || (lecture.id === state.lecture?.id ? elapsed() : 0);
  return [formatDate(lecture.createdAt), duration ? formatDuration(duration) : '', lecture.fileName ? `from ${lecture.fileName}` : '']
    .filter(Boolean).join(' · ');
}

function notesText(lecture) {
  const { notes } = lecture;
  return `# ${lecture.title}\n\n_${lectureMeta(lecture)}_\n\n> ${notes.summary}\n\n${notes.markdown}\n`;
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

  let ts;
  if (segment.t == null) {
    ts = document.createElement('span'); // imported plain text has no timestamps
    ts.className = 'ts-none';
  } else {
    ts = document.createElement('button');
    ts.type = 'button';
    ts.className = 'ts';
    ts.textContent = formatClock(segment.t);
    ts.title = 'Play from here';
  }

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

// Where each break (a continued session, or a lecture merged in) starts, as a
// segment index. Merged breaks store the index; continued ones only a time.
function breakPositions(lecture) {
  const segments = lecture?.segments ?? [];
  return (lecture?.breaks || []).map((pause, order) => {
    let at = pause.index ?? segments.findIndex((s) => s.t != null && s.t >= pause.t);
    if (at === -1 || at > segments.length) at = segments.length;
    return { at, order, pause };
  });
}

function breakLabel(pause) {
  return `${pause.label || 'Continued'} · ${formatDate(pause.at)}`;
}

function dividerEl(pause) {
  const div = document.createElement('div');
  div.className = 'seg-divider';
  const label = document.createElement('span');
  label.textContent = breakLabel(pause);
  label.title = label.textContent;
  div.append(label);
  return div;
}

function renderTranscript() {
  const lecture = state.lecture;
  const segments = lecture?.segments ?? [];
  const rows = segments.map(segmentEl);
  // Insert dividers from the end backwards so earlier positions stay valid.
  const marks = breakPositions(lecture).sort((a, b) => b.at - a.at || b.order - a.order);
  for (const { at, pause } of marks) rows.splice(at, 0, dividerEl(pause));
  els.segments.replaceChildren(...rows);
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
    if (!state.playbackParts.length || segment.t == null) return;
    playAt(segment.t);
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

// --- AI settings -------------------------------------------------------------------------

function aiConfig() {
  const prefs = loadPrefs();
  const provider = PROVIDERS[prefs.provider] ? prefs.provider : 'anthropic';
  return {
    provider,
    apiKey: (prefs.keys?.[provider] || '').trim(),
    model: (prefs.models?.[provider] || PROVIDERS[provider].defaultModel || '').trim(),
    baseUrl: (prefs.baseUrl || '').trim(),
  };
}

function providerName(provider = aiConfig().provider) {
  return PROVIDERS[provider].label.split(' (')[0];
}

function aiReady() {
  const { provider, apiKey, model, baseUrl } = aiConfig();
  const p = PROVIDERS[provider];
  if (!model || (p.needsBaseUrl && !baseUrl)) return false;
  return Boolean(apiKey) || Boolean(p.keyOptional);
}

// Stores a per-provider value (keys, models) for the selected provider.
function saveProviderPref(field, value) {
  const prefs = loadPrefs();
  savePrefs({ [field]: { ...(prefs[field] || {}), [aiConfig().provider]: value } });
}

// Shows enough of a saved key to tell which one it is, without revealing it.
function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '•'.repeat(key.length);
}

// Key prefixes that clearly belong to a different provider.
const FOREIGN_KEY = {
  anthropic: [/^AIza/, 'a Google key'],
  gemini: [/^sk-ant-/, 'an Anthropic key', /^sk-/, 'an OpenAI key'],
  openai: [/^sk-ant-/, 'an Anthropic key', /^AIza/, 'a Google key'],
};

function foreignKeyWarning(provider, key) {
  const rules = FOREIGN_KEY[provider] || [];
  for (let i = 0; i < rules.length; i += 2) {
    if (rules[i].test(key)) return `That looks like ${rules[i + 1]}, not a ${providerName(provider)} key.`;
  }
  return '';
}

function renderAISettings({ keepCustomModel = false } = {}) {
  const { provider, apiKey, model, baseUrl } = aiConfig();
  const p = PROVIDERS[provider];
  els.providerSelect.value = provider;
  renderModelSelect(keepCustomModel);
  els.baseUrlField.hidden = !p.needsBaseUrl;
  els.baseUrlInput.value = baseUrl;
  els.apiKeyLabel.textContent = `${providerName(provider)} API key${p.keyOptional ? ' (optional)' : ''}`;
  els.apiKey.value = '';
  els.apiKey.placeholder = apiKey ? `Saved: ${maskKey(apiKey)} (paste a new key to replace it)` : p.keyPlaceholder;
  const warning = apiKey ? foreignKeyWarning(provider, apiKey) : '';
  els.providerHelp.textContent = `${warning ? `⚠ ${warning} ` : ''}${p.keyHelp} Keys are stored in this browser only and sent only to the provider.`;
  els.providerHelp.classList.toggle('warn', Boolean(warning));
  els.providerSummary.textContent = aiReady() ? `${providerName(provider)} · ${model}` : 'Not set up';
}

const CUSTOM_MODEL = '__custom__';
const fetchedModels = {}; // provider -> models the saved key can use

function renderModelSelect(keepCustom = false) {
  const { provider, model } = aiConfig();
  const p = PROVIDERS[provider];
  const fetched = (fetchedModels[provider] || []).filter((m) => !p.models.includes(m)).sort();
  const selected = model && !p.models.includes(model) && !fetched.includes(model) ? [model] : [];

  const group = (label, ids) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...ids.map((id) => new Option(id === p.defaultModel ? `${id} (default)` : id, id)));
    return g;
  };
  const options = [];
  if (selected.length) options.push(group('Selected', selected));
  if (p.models.length) options.push(group('Recommended', p.models));
  if (fetched.length) options.push(group('Available with your key', fetched));
  options.push(new Option('Other model (type its name)…', CUSTOM_MODEL));

  const customOpen = keepCustom && !els.modelInput.hidden;
  els.modelSelect.replaceChildren(...options);
  if (customOpen || !model) {
    els.modelSelect.value = CUSTOM_MODEL;
    els.modelInput.hidden = false;
    if (!customOpen) els.modelInput.value = '';
  } else {
    els.modelSelect.value = model;
    els.modelInput.hidden = true;
  }
  els.modelInput.placeholder = provider === 'compatible' ? 'e.g. meta-llama/llama-4-scout' : 'Exact model name';
}

// Adds the models this key can actually use to the dropdown.
async function refreshModelSuggestions() {
  const config = aiConfig();
  const p = PROVIDERS[config.provider];
  if (!config.apiKey && !p.keyOptional) return;
  const models = await listModels(config);
  if (models.length && aiConfig().provider === config.provider) {
    fetchedModels[config.provider] = models;
    renderModelSelect(true);
  }
}

// --- Notes -----------------------------------------------------------------------------

const queuedIds = new Set(); // lectures waiting for their turn to be summarized
let notesChain = Promise.resolve();

function isSummarizing(id) {
  return id != null && (state.generatingId === id || queuedIds.has(id));
}

function queueNotes(lecture) {
  if (!lecture?.segments.length || isSummarizing(lecture.id)) return;
  if (!aiReady()) {
    els.settings.open = true;
    els.settings.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (aiConfig().model ? els.apiKey : els.modelSelect).focus({ preventScroll: true });
    return;
  }
  queuedIds.add(lecture.id);
  if (state.lecture?.id === lecture.id) state.notesError = '';
  renderNotes();
  renderLibrary();
  notesChain = notesChain.then(() => summarize(lecture.id));
}

async function summarize(id) {
  queuedIds.delete(id);
  // Use the copy that's on screen, if any, so edits made while waiting are kept.
  const lecture = state.lecture?.id === id ? state.lecture : await db.get(id).catch(() => null);
  if (!lecture) return; // deleted while queued

  const config = aiConfig();
  const name = providerName(config.provider);
  const started = Date.now();
  let chars = 0;
  const setProgress = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    state.notesProgress = chars
      ? `Writing notes… ${chars.toLocaleString()} characters`
      : `Waiting for ${name}… ${secs}s`;
    if (state.lecture?.id === id) els.notesStatus.textContent = state.notesProgress;
  };
  state.generatingId = id;
  setProgress();
  const ticker = setInterval(setProgress, 1000);
  renderNotes();
  renderLibrary();

  let error = '';
  try {
    const result = await generateNotes({
      ...config,
      title: lecture.title,
      segments: lecture.segments,
      onProgress: (n) => {
        chars = n;
        setProgress();
      },
    });
    const target = state.lecture?.id === id ? state.lecture : lecture;
    const chatter = new Set(result.chatterIds);
    target.segments.forEach((s, i) => { s.chatter = chatter.has(i); });
    target.notes = {
      summary: result.summary,
      markdown: result.markdown,
      model: result.model,
      provider: config.provider,
      generatedAt: Date.now(),
    };
    if (!target.titleEdited && result.title) target.title = result.title;
    if (await db.get(id).catch(() => null)) await persist(target); // skip if deleted meanwhile
  } catch (err) {
    console.error(err);
    error = err.message || 'Something went wrong generating notes.';
  } finally {
    clearInterval(ticker);
    state.generatingId = null;
    state.notesProgress = '';
  }

  if (state.lecture?.id === id) {
    state.notesError = error;
    els.title.value = state.lecture.title;
    renderTranscript();
  } else if (error) {
    showNotice(`Couldn’t summarize “${lecture.title}”: ${error}`);
  }
  renderNotes();
  renderLibrary();
}

function updateNotesControls() {
  const lecture = state.lecture;
  const generating = state.generatingId != null && state.generatingId === lecture?.id;
  const busy = isSummarizing(lecture?.id);
  els.generateBtn.disabled = !(lecture?.status === 'done' && lecture.segments.length > 0 && !busy);
  els.generateBtn.textContent = generating ? 'Generating…' : busy ? 'Queued…' : lecture?.notes ? 'Regenerate' : 'Generate notes';
  els.copyNotesBtn.disabled = els.downloadNotesBtn.disabled = !lecture?.notes;
  els.continueBtn.hidden = !(state.status === 'stopped' && lecture?.status === 'done');
  els.continueBtn.disabled = !canContinue(lecture);
  els.continueBtn.title = busy ? 'Wait for the notes to finish first' : 'Record more into this lecture';
}

function renderNotes() {
  const lecture = state.lecture;
  const notes = lecture?.notes;
  const generating = state.generatingId != null && state.generatingId === lecture?.id;
  const queued = queuedIds.has(lecture?.id);
  const body = [];

  if (state.notesError) {
    const p = document.createElement('p');
    p.className = 'notes-error';
    p.textContent = state.notesError;
    body.push(p);
  }

  if (notes && lecture.continuedAt > notes.generatedAt && !generating && !queued) {
    const p = document.createElement('p');
    p.className = 'notes-stale';
    p.textContent = 'These notes were written before you continued the lecture. Press Regenerate to include the new part.';
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
    typesetMath(md); // LaTeX → KaTeX, loaded only when the notes contain math
    els.notesStatus.textContent = `Generated ${formatDate(notes.generatedAt)}${notes.model ? ` · ${notes.model}` : ''}`;
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const msg = document.createElement('p');
    const sub = document.createElement('p');
    sub.className = 'muted';
    const about = 'The AI summarizes the lecture, organizes the notes, and removes background chatter from students.';
    if (generating) {
      msg.textContent = `${providerName()} is reading the transcript…`;
      sub.textContent = 'Long lectures can take a minute or two.';
    } else if (queued) {
      msg.textContent = 'Queued. Another transcript is being summarized first.';
    } else if (!aiReady()) {
      msg.textContent = 'Choose an AI provider and add its API key under AI settings to turn transcripts into study notes.';
      sub.textContent = `Works with Claude, Gemini, OpenAI, and OpenAI-compatible services. ${about}`;
    } else if (lecture?.status === 'done' && lecture.segments.length) {
      msg.textContent = 'No notes yet for this lecture.';
      sub.textContent = 'Press Generate notes to summarize it and remove background chatter.';
    } else {
      msg.textContent = 'Notes appear here after you stop recording or import a transcript.';
      sub.textContent = about;
    }
    empty.append(msg);
    if (sub.textContent) empty.append(sub);
    body.push(empty);
    els.notesStatus.textContent = '';
  }

  if (generating) els.notesStatus.textContent = state.notesProgress;
  else if (queued) els.notesStatus.textContent = 'Queued…';
  els.notesBody.replaceChildren(...body);
  updateNotesControls();
}

// --- Importing transcript files ------------------------------------------------------------

async function importFiles(fileList) {
  const imported = [];
  const problems = [];
  for (const file of [...fileList]) {
    const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    if (!IMPORT_EXTENSIONS.includes(ext) && !file.type.startsWith('text/')) {
      problems.push(`${file.name} (only text files are supported; save Word or PDF files as .txt first)`);
      continue;
    }
    if (file.size > 20 * 1024 * 1024) {
      problems.push(`${file.name} (file is too large)`);
      continue;
    }
    let parsed;
    try {
      parsed = parseTranscript(await file.text());
    } catch (err) {
      console.error(err);
      problems.push(`${file.name} (couldn’t be read)`);
      continue;
    }
    if (!parsed.segments.length) {
      problems.push(`${file.name} (no text found)`);
      continue;
    }
    const lecture = {
      id: crypto.randomUUID(),
      title: file.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Imported transcript',
      titleEdited: false, // let the AI suggest a descriptive title; the file name stays in fileName
      createdAt: Date.now(),
      duration: parsed.duration,
      lang: els.langSelect.value,
      engine: 'import',
      source: 'import',
      fileName: file.name,
      segments: parsed.segments,
      notes: null,
      mimeType: '',
      audioBlob: null,
      status: 'done',
    };
    await persist(lecture);
    imported.push(lecture);
  }

  if (problems.length) showNotice(`Couldn’t import ${problems.join(', ')}.`);
  else if (!isLive()) hideNotice();
  if (!imported.length) {
    renderLibrary();
    return;
  }
  if (isLive()) renderLibrary(); // don't interrupt a recording; the imports are in the library
  else showLecture(imported[0]);

  if (!aiReady()) {
    queueNotes(imported[0]); // opens AI settings
    return;
  }
  for (const lecture of imported) queueNotes(lecture);
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  importFiles(e.dataTransfer.files);
});

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

  els.selectBtn.hidden = lectures.length < 2 && !state.selecting;
  if (state.selecting) updateMergeBar(lectures);

  els.libraryList.replaceChildren(...lectures.map((lecture) => {
    const li = document.createElement('li');
    li.className = 'lecture-item';
    li.classList.toggle('active', lecture.id === state.lecture?.id && !state.selecting);

    if (state.selecting) {
      const blocker = mergeBlocker(lecture);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'select-box';
      box.checked = state.selectedIds.has(lecture.id);
      box.disabled = Boolean(blocker);
      box.setAttribute('aria-label', `Select “${lecture.title}”`);
      li.classList.add('selectable');
      li.classList.toggle('selected', box.checked);
      li.classList.toggle('blocked', Boolean(blocker));
      li.title = blocker;
      const toggle = () => {
        if (blocker) return;
        if (state.selectedIds.has(lecture.id)) state.selectedIds.delete(lecture.id);
        else state.selectedIds.add(lecture.id);
        renderLibrary();
      };
      li.addEventListener('click', (e) => {
        if (e.target !== box) toggle();
      });
      box.addEventListener('change', toggle);
      li.append(box);
    }

    const h3 = document.createElement('h3');
    h3.textContent = lecture.title;
    h3.title = lecture.title;

    const meta = document.createElement('div');
    meta.className = 'lecture-meta';
    const words = keptSegments(lecture).reduce((n, s) => n + countWords(s.text), 0);
    const details = [formatDate(lecture.createdAt), lecture.duration ? formatDuration(lecture.duration) : '', `${words.toLocaleString()} words`];
    for (const text of details.filter(Boolean)) {
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
    if (lecture.source === 'import') badge('Imported', 'badge-ok');
    if (lecture.source === 'merge') badge(`Merged ×${lecture.mergedFrom?.length || 2}`, 'badge-ok');
    if (state.generatingId === lecture.id) badge('Summarizing…');
    else if (queuedIds.has(lecture.id)) badge('Queued');
    else if (lecture.notes) badge('Notes', 'badge-ok');

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
    actions.hidden = state.selecting;

    li.append(h3, meta, preview, actions);
    return li;
  }));
}

function isLive() {
  return state.status === 'recording' || state.status === 'paused' || state.status === 'stopping';
}

async function openLecture(id) {
  if (isLive()) return;
  const lecture = await db.get(id);
  if (lecture) showLecture(lecture);
}

function showLecture(lecture) {
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
  queuedIds.delete(lecture.id);
  await db.remove(lecture.id);
  if (state.lecture?.id === lecture.id) resetToIdle();
  renderLibrary();
}

// --- Merging lectures ------------------------------------------------------------------

// A lecture can be merged unless it's being recorded or its notes are being written.
function mergeBlocker(lecture) {
  if (lecture.status !== 'done' || (isLive() && lecture.id === state.lecture?.id)) return 'Being recorded';
  if (isSummarizing(lecture.id)) return 'Notes are being written';
  return '';
}

function setSelecting(on) {
  state.selecting = on;
  state.selectedIds.clear();
  els.selectBtn.textContent = on ? 'Cancel' : 'Select to merge';
  els.mergeBar.hidden = !on;
  renderLibrary();
}

function updateMergeBar(lectures) {
  const chosen = lectures.filter((l) => state.selectedIds.has(l.id)).sort((a, b) => a.createdAt - b.createdAt);
  els.mergeBtn.disabled = chosen.length < 2;
  els.mergeCount.textContent = chosen.length < 2
    ? 'Select two or more lectures to merge.'
    : `Merge in recording order: ${chosen.map((l) => `“${l.title}”`).join(' → ')}`;
}

/** Joins lectures (in recording order) into a new lecture. */
function buildMerged(lectures) {
  const merged = {
    id: crypto.randomUUID(),
    title: `${lectures[0].title} (merged)`,
    titleEdited: false, // let the AI suggest a title covering all parts
    createdAt: lectures[0].createdAt,
    duration: 0,
    lang: lectures[0].lang,
    engine: 'merge',
    source: 'merge',
    mergedFrom: lectures.map((l) => ({ id: l.id, title: l.title, createdAt: l.createdAt })),
    segments: [],
    breaks: [],
    audioParts: [],
    notes: null,
    mimeType: lectures.at(-1).mimeType || '',
    status: 'done',
  };

  let offset = 0;
  for (const lecture of lectures) {
    const base = merged.segments.length;
    // A merged lecture already starts with its own labelled dividers.
    if (lecture.source !== 'merge') merged.breaks.push({ index: base, t: offset, at: lecture.createdAt, label: lecture.title });
    // Keep the lecture's own continuation dividers, re-anchored in the merged transcript.
    for (const { at, pause } of breakPositions(lecture)) {
      merged.breaks.push({ ...pause, index: base + at, t: (pause.t ?? 0) + offset });
    }
    merged.segments.push(...lecture.segments.map((s) => ({ ...s, t: s.t == null ? null : s.t + offset })));
    merged.audioParts.push(...audioPartsOf(lecture).map((p) => ({ ...p, start: p.start + offset })));

    // Imported transcripts only know when their last line started; leave a gap after them.
    const lastLine = Math.max(0, ...lecture.segments.map((s) => s.t ?? 0));
    const length = Math.max(lecture.duration || 0, lastLine);
    offset += length + (lecture.source === 'import' && length ? 5000 : 0);
  }
  merged.duration = offset;
  return merged;
}

async function mergeSelected() {
  const ids = [...state.selectedIds];
  // Prefer the on-screen copy of a lecture: it may have edits that haven't been saved yet.
  const lectures = (await Promise.all(ids.map((id) => (state.lecture?.id === id ? state.lecture : db.get(id)))))
    .filter((l) => l && !mergeBlocker(l))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (lectures.length < 2) return;

  const removeOriginals = els.removeOriginals.checked;
  if (removeOriginals && !confirm(`Merge ${lectures.length} lectures and delete the originals? The merged lecture keeps all their recordings and transcripts.`)) return;

  const merged = buildMerged(lectures);
  await persist(merged);
  if (removeOriginals) {
    for (const l of lectures) {
      queuedIds.delete(l.id);
      await db.remove(l.id);
    }
  }
  setSelecting(false);
  if (!isLive()) showLecture(merged);
  else renderLibrary();
  if (aiReady()) queueNotes(merged);
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
  document.body.dataset.status = s; // drives which controls show, and pauses the background animation
  els.pauseBtn.classList.toggle('is-paused', s === 'paused');
  updateRecSettingsSummary();
  els.newBtn.hidden = s !== 'stopped';
  document.title = s === 'recording' ? '● Recording – LectureListen' : 'LectureListen';
  updateNotesControls();
}

// --- Wiring ------------------------------------------------------------------------------

els.recordBtn.addEventListener('click', () => startRecording());
els.pauseBtn.addEventListener('click', togglePause);
els.stopBtn.addEventListener('click', stopRecording);
els.newBtn.addEventListener('click', resetToIdle);

els.downloadAudioBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (!l) return;
  const parts = audioPartsOf(l).filter((p) => p.blob?.size);
  parts.forEach((part, i) => {
    const suffix = parts.length > 1 ? `-part${i + 1}` : '';
    // Stagger the downloads so the browser doesn't drop any.
    setTimeout(() => download(part.blob, `${slugify(l.title)}${suffix}.${audioExtension(part.mimeType || l.mimeType)}`), i * 400);
  });
});
els.player.addEventListener('ended', () => {
  // Carry on into the next part of a continued lecture.
  if (state.partIndex < state.playbackParts.length - 1) loadPart(state.partIndex + 1, 0, true);
});
els.continueBtn.addEventListener('click', () => startRecording({ resume: true }));
els.copyBtn.addEventListener('click', () => state.lecture && copyText(transcriptText(state.lecture), els.copyBtn));
els.downloadTxtBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (l) download(new Blob([transcriptText(l)], { type: 'text/plain' }), `${slugify(l.title)}-transcript.txt`);
});
els.chatterToggle.addEventListener('click', () => {
  state.showChatter = !state.showChatter;
  updateTranscriptMeta();
});

els.generateBtn.addEventListener('click', () => queueNotes(state.lecture));
els.copyNotesBtn.addEventListener('click', () => state.lecture?.notes && copyText(notesText(state.lecture), els.copyNotesBtn));
els.downloadNotesBtn.addEventListener('click', () => {
  const l = state.lecture;
  if (l?.notes) download(new Blob([notesText(l)], { type: 'text/markdown' }), `${slugify(l.title)}-notes.md`);
});

const aiSettingsChanged = () => {
  renderAISettings();
  renderNotes();
};
els.providerSelect.addEventListener('change', () => {
  savePrefs({ provider: els.providerSelect.value });
  aiSettingsChanged();
  refreshModelSuggestions();
});
els.modelSelect.addEventListener('change', () => {
  if (els.modelSelect.value === CUSTOM_MODEL) {
    els.modelInput.hidden = false;
    els.modelInput.value = '';
    els.modelInput.focus();
    return;
  }
  saveProviderPref('models', els.modelSelect.value);
  aiSettingsChanged();
});
els.modelInput.addEventListener('change', () => {
  const name = els.modelInput.value.trim();
  if (!name) return;
  saveProviderPref('models', name);
  aiSettingsChanged();
});
els.modelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.modelInput.blur(); // commits via the change event
});
els.baseUrlInput.addEventListener('change', () => {
  savePrefs({ baseUrl: els.baseUrlInput.value.trim() });
  aiSettingsChanged();
  refreshModelSuggestions();
});
els.saveKeyBtn.addEventListener('click', () => {
  const key = els.apiKey.value.replace(/\s+/g, ''); // keys never contain spaces or line breaks
  if (!key) return;
  saveProviderPref('keys', key);
  aiSettingsChanged();
  refreshModelSuggestions();
});
els.apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.saveKeyBtn.click();
});
els.clearKeyBtn.addEventListener('click', () => {
  saveProviderPref('keys', '');
  aiSettingsChanged();
});

els.selectBtn.addEventListener('click', () => setSelecting(!state.selecting));
els.mergeBtn.addEventListener('click', mergeSelected);

els.importBtn.addEventListener('click', () => els.importInput.click());
els.emptyImportBtn.addEventListener('click', () => els.importInput.click());
els.importInput.addEventListener('change', () => {
  importFiles(els.importInput.files);
  els.importInput.value = ''; // allow re-importing the same file
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
for (const select of [els.micSelect, els.langSelect, els.engineSelect]) select.addEventListener('change', updateRecSettingsSummary);
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
  if (isLive() || state.generatingId || queuedIds.size) {
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
  if (prefs.apiKey) {
    // Move the single Claude key from earlier versions into the per-provider keys.
    savePrefs({ keys: { anthropic: prefs.apiKey, ...(prefs.keys || {}) }, apiKey: undefined });
  }
  els.providerSelect.replaceChildren(...Object.entries(PROVIDERS).map(([id, p]) => new Option(p.label, id)));
  renderAISettings();
  refreshModelSuggestions();

  if (location.protocol !== 'file:' && !window.MediaRecorder) {
    els.banner.hidden = false;
    els.banner.textContent = 'This browser can’t record audio. Use a recent Firefox, Chrome, Edge or Safari.';
  }

  populateEngines();

  populateLanguages();
  populateMics();
  resetToIdle();
  window.lectureListenReady = true; // hides index.html's "couldn't start" fallback
  await recoverInterrupted();
  renderLibrary();
}

init();
