// Parses transcript files into timestamped segments so they can be summarized
// like a recording. Handles SRT/VTT subtitles, "[mm:ss] text" lines (including
// Mivimoose Listen's own .txt export), "Speaker  0:03" blocks (Otter-style) and
// plain text.

export const IMPORT_EXTENSIONS = ['.txt', '.md', '.srt', '.vtt', '.text', '.log'];

const TIME = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`;
const CUE_TIMING = new RegExp(`^${TIME}\\s*-->\\s*${TIME}`);
const LINE_STAMP = new RegExp(`^[\\[(]?${TIME}[\\])]?\\s*[-–:]?\\s+(.+)$`);
const SPEAKER_STAMP = new RegExp(`^(?:(.{0,60}?)\\s+)?${TIME}$`);

function toMs(h, m, s, frac) {
  return ((Number(h || 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number((frac || '0').padEnd(3, '0'));
}

function cleanText(s) {
  return s
    .replace(/<[^>]+>/g, '') // VTT voice/styling tags
    .replace(/\{\\[^}]*\}/g, '') // SRT positioning like {\an8}
    .replace(/\s+/g, ' ')
    .trim();
}

// Joins subtitle cues that split a sentence, but keeps sentences apart so a
// line of chatter never gets glued onto lecture content.
function mergeCues(cues) {
  const segments = [];
  let current = null;
  for (const cue of cues) {
    if (!current) {
      current = { ...cue };
    } else {
      current.text += ` ${cue.text}`;
    }
    const endsSentence = /[.?!…]["')\]]?$/.test(current.text);
    if (endsSentence || current.text.length >= 250) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function parseCues(text) {
  const cues = [];
  let previous = '';
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((l) => CUE_TIMING.test(l));
    if (timingIndex === -1) continue; // WEBVTT header, NOTE, STYLE, …
    const m = lines[timingIndex].match(CUE_TIMING);
    const body = cleanText(lines.slice(timingIndex + 1).join(' '));
    if (!body || body === previous) continue; // auto-captions often repeat lines
    // Rolling captions repeat the previous line as a prefix; keep only what's new.
    const fresh = previous && body.startsWith(previous) ? body.slice(previous.length).trim() : body;
    previous = body;
    if (fresh) cues.push({ t: toMs(m[1], m[2], m[3], m[4]), text: fresh });
  }
  return mergeCues(cues);
}

function parseStampedLines(lines) {
  const segments = [];
  let pendingTime = null; // from a "Speaker  0:03" line; applies to the text below it
  let started = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(LINE_STAMP);
    if (m) {
      started = true;
      segments.push({ t: toMs(m[1], m[2], m[3], m[4]), text: cleanText(m[5]) });
      pendingTime = null;
      continue;
    }
    m = line.match(SPEAKER_STAMP);
    if (m) {
      started = true;
      pendingTime = toMs(m[2], m[3], m[4], m[5]);
      continue;
    }
    if (!started) continue; // title/date header before the transcript starts
    if (pendingTime !== null) {
      segments.push({ t: pendingTime, text: cleanText(line) });
      pendingTime = null;
    } else if (segments.length) {
      segments.at(-1).text += ` ${cleanText(line)}`; // continuation line
    }
  }
  return segments.filter((s) => s.text);
}

// Splits plain prose into paragraph-sized segments without timestamps.
function parsePlain(text) {
  const segments = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const clean = cleanText(paragraph.replace(/^#+\s*/gm, ''));
    if (!clean) continue;
    if (clean.length <= 500) {
      segments.push({ t: null, text: clean });
      continue;
    }
    let chunk = '';
    for (const sentence of clean.match(/[^.?!…]+(?:[.?!…]+["')\]]?|$)\s*/g) || [clean]) {
      if (chunk && chunk.length + sentence.length > 350) {
        segments.push({ t: null, text: chunk.trim() });
        chunk = '';
      }
      chunk += sentence;
    }
    if (chunk.trim()) segments.push({ t: null, text: chunk.trim() });
  }
  return segments;
}

/**
 * @param {string} text file contents
 * @returns {{ segments: {t: number|null, text: string}[], duration: number, format: string }}
 */
export function parseTranscript(text) {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  let segments;
  let format;
  if (/^WEBVTT/.test(normalized) || lines.some((l) => CUE_TIMING.test(l.trim()))) {
    segments = parseCues(normalized);
    format = 'subtitles';
  } else {
    const nonEmpty = lines.filter((l) => l.trim());
    const stamped = nonEmpty.filter((l) => LINE_STAMP.test(l.trim()) || SPEAKER_STAMP.test(l.trim())).length;
    if (stamped >= 3 && stamped >= nonEmpty.length * 0.2) {
      segments = parseStampedLines(lines);
      format = 'timestamped';
    } else {
      segments = parsePlain(normalized);
      format = 'plain';
    }
  }

  const times = segments.map((s) => s.t).filter((t) => t != null);
  return { segments, duration: times.length ? Math.max(...times) : 0, format };
}
