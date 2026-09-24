// Turns a lecture transcript into study notes with Claude, and renders the
// Markdown it returns. The SDK is loaded on first use so recording keeps
// working offline.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';
export const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You turn raw lecture transcripts into clean study notes for a student.

The transcript comes from live browser speech recognition on a microphone in a lecture room. Each line is "[id] (timestamp) text". Expect recognition errors: misheard words, missing punctuation, sentences split across lines. The microphone also picks up talk that is not part of the lecture: students chatting with each other, side conversations, remarks to a neighbour, phone calls, people arriving or packing up.

Produce four fields:

chatter_segment_ids: the ids of lines that are background chatter rather than lecture content. Student questions to the lecturer, the lecturer's answers, and course logistics announced to the class (deadlines, exams, readings) are lecture content, so keep them. Keep a line that mixes lecture content with chatter. When you can't tell, keep the line: a missed bit of chatter costs the student far less than lost lecture material.

summary: two to four sentences on what the lecture covered.

notes_markdown: well-organized study notes built only from the lecture content. Use "##" headings for the main topics in the order they were taught, bullet points for the key points, and **bold** for key terms with a short definition. Include formulas, worked examples, and anything the lecturer flagged as important or likely to be examined. Use context to correct obvious recognition mistakes (such as misheard technical terms), but do not add material that wasn't said. If the lecturer mentioned assignments, readings, or dates, end with a "## Announcements & to-dos" section. Finish with a "## Questions to review" section of three to five self-test questions. Use only headings, bullet and numbered lists (nest with two spaces), bold, italics, inline code, blockquotes, and paragraphs: no tables or HTML.

title: a short descriptive title for the lecture, under 60 characters.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    notes_markdown: { type: 'string' },
    chatter_segment_ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['title', 'summary', 'notes_markdown', 'chatter_segment_ids'],
  additionalProperties: false,
};

let sdkPromise = null;

function loadSdk() {
  sdkPromise ??= import(SDK_URL).catch(() => {
    sdkPromise = null;
    throw new Error("Couldn't load the Claude SDK. Check your internet connection and try again.");
  });
  return sdkPromise;
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * @param {{ apiKey: string, title: string, segments: {t: number, text: string}[], onProgress?: (chars: number) => void }} options
 * @returns {Promise<{ title: string, summary: string, markdown: string, chatterIds: number[], model: string }>}
 */
export async function generateNotes({ apiKey, title, segments, onProgress }) {
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const transcript = segments.map((s, i) => `[${i}] (${clock(s.t)}) ${s.text}`).join('\n');

  let message;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: `Lecture title as entered by the student (may be a placeholder): ${title}\n\n<transcript>\n${transcript}\n</transcript>`,
      }],
    });
    let chars = 0;
    stream.on('text', (delta) => {
      chars += delta.length;
      onProgress?.(chars);
    });
    message = await stream.finalMessage();
  } catch (err) {
    throw friendlyError(err, Anthropic);
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this transcript.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The notes were cut off before they finished. Try again, or split the lecture into shorter recordings.');
  }

  // If a fallback model took over, only the text after the last switch point is the answer.
  const lastFallback = message.content.findLastIndex((b) => b.type === 'fallback');
  const text = message.content
    .slice(lastFallback + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Claude's response couldn't be read. Please try again.");
  }

  const chatterIds = [...new Set(data.chatter_segment_ids)]
    .filter((id) => Number.isInteger(id) && id >= 0 && id < segments.length);

  return {
    title: String(data.title || '').trim(),
    summary: String(data.summary || '').trim(),
    markdown: String(data.notes_markdown || '').trim(),
    chatterIds,
    model: message.model,
  };
}

function friendlyError(err, Anthropic) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Claude rejected the API key. Check it under Claude settings.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error("This API key doesn't have access to the model.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Rate limit reached. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error("Couldn't reach the Claude API. Check your internet connection.");
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude API error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  }
  return err;
}

// --- Markdown -------------------------------------------------------------
// A small renderer for the subset the prompt asks for. All text is escaped
// before any tags are added, so model output can't inject HTML.

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  const codes = [];
  let out = escapeHtml(s).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  out = out
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const lists = []; // stack of { type, indent }
  let html = '';
  let para = [];

  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) html += `</li></${lists.pop().type}>`;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    let m;

    if (!trimmed) {
      flushPara();
    } else if ((m = trimmed.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeLists();
      const level = m[1].length;
      html += `<h${level}>${inline(m[2].replace(/\s+#+$/, ''))}</h${level}>`;
    } else if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushPara(); closeLists();
      html += '<hr>';
    } else if ((m = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists.at(-1);
      if (top && top.indent === indent && top.type === type) {
        html += '</li><li>';
      } else {
        if (top && top.indent === indent) html += `</li></${lists.pop().type}>`;
        html += `<${type}><li>`;
        lists.push({ type, indent });
      }
      html += inline(m[2]);
    } else if (trimmed.startsWith('>')) {
      flushPara(); closeLists();
      html += `<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`;
    } else if (lists.length && indent > 0) {
      html += ' ' + inline(trimmed); // continuation of a list item
    } else {
      closeLists();
      para.push(trimmed);
    }
  }
  flushPara();
  closeLists();
  return html;
}
