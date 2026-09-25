// Turns a lecture transcript into study notes with the AI provider the user
// picked (Claude, Gemini, OpenAI or any OpenAI-compatible API), and renders the
// Markdown it returns. Everything is called directly from the browser.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5'],
    keyPlaceholder: 'sk-ant-…',
    keyHelp: 'Create a key at console.anthropic.com.',
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
    keyPlaceholder: 'Paste your Gemini API key',
    keyHelp: 'Create a key at aistudio.google.com/api-keys. Keys made before May 28, 2026 (“standard” keys) are no longer accepted by the Gemini API.',
    keyRejectedHint: 'Check that the whole key was copied. Gemini also no longer accepts keys created before May 28, 2026; if yours is older, create a new key at aistudio.google.com/api-keys and paste it under AI settings.',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-6-sol',
    models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'],
    keyPlaceholder: 'sk-…',
    keyHelp: 'Create a key at platform.openai.com/api-keys.',
  },
  compatible: {
    label: 'OpenAI-compatible (OpenRouter, Groq, Ollama…)',
    defaultModel: '',
    models: [],
    keyPlaceholder: 'API key (leave empty for local servers)',
    keyHelp: 'Any service with an OpenAI-style /chat/completions endpoint. Local servers such as Ollama must allow this page’s origin (for Ollama, set OLLAMA_ORIGINS).',
    needsBaseUrl: true,
    keyOptional: true,
  },
};

const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_API = 'https://api.openai.com/v1';

const SYSTEM_PROMPT = `You turn raw lecture transcripts into clean study notes for a student.

The transcript usually comes from speech recognition on a microphone in a lecture room, though it may also be a transcript file the student already had. Each line is "[id] (timestamp) text", or "[id] text" when there are no timestamps. Expect recognition errors: misheard words, missing punctuation, sentences split across lines. The microphone may also have picked up talk that is not part of the lecture: students chatting with each other, side conversations, remarks to a neighbour, phone calls, people arriving or packing up.

Produce four fields:

chatter_segment_ids: the ids of lines that are background chatter rather than lecture content. Student questions to the lecturer, the lecturer's answers, and course logistics announced to the class (deadlines, exams, readings) are lecture content, so keep them. Keep a line that mixes lecture content with chatter. When you can't tell, keep the line: a missed bit of chatter costs the student far less than lost lecture material.

summary: two to four sentences on what the lecture covered.

notes_markdown: well-organized study notes built only from the lecture content. Use "##" headings for the main topics in the order they were taught, bullet points for the key points, and **bold** for key terms with a short definition. Include formulas, worked examples, and anything the lecturer flagged as important or likely to be examined. Use context to correct obvious recognition mistakes (such as misheard technical terms), but do not add material that wasn't said. If the lecturer mentioned assignments, readings, or dates, end with a "## Announcements & to-dos" section. Finish with a "## Questions to review" section of three to five self-test questions. Write every mathematical expression, formula, equation, and chemical or physical quantity in LaTeX: inline as $...$ (for example $E = mc^2$), and important equations on a line of their own as $$...$$. Use only these dollar delimiters, not \( \) or \[ \], and always close every formula you open. Turn spoken maths ("x squared over two") into proper notation. Use only headings, bullet and numbered lists (nest with two spaces), bold, italics, inline code, blockquotes, paragraphs, and LaTeX math: no tables or HTML.

title: a short descriptive title for the lecture, under 60 characters.

Respond with a single JSON object with exactly the keys title, summary, notes_markdown and chatter_segment_ids.`;

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

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function userMessage(title, segments) {
  const transcript = segments
    .map((s, i) => (s.t == null ? `[${i}] ${s.text}` : `[${i}] (${clock(s.t)}) ${s.text}`))
    .join('\n');
  return `Lecture title as entered by the student (may be a placeholder or a file name): ${title}\n\n<transcript>\n${transcript}\n</transcript>`;
}

/**
 * @param {{ provider: keyof PROVIDERS, apiKey: string, model?: string, baseUrl?: string,
 *           title: string, segments: {t: number|null, text: string}[], onProgress?: (chars: number) => void }} options
 * @returns {Promise<{ title: string, summary: string, markdown: string, chatterIds: number[], model: string }>}
 */
export async function generateNotes({ provider, apiKey, model, baseUrl, title, segments, onProgress }) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown AI provider: ${provider}`);
  const request = {
    apiKey,
    model: (model || config.defaultModel).trim(),
    baseUrl: (baseUrl || '').trim().replace(/\/+$/, ''),
    user: userMessage(title, segments),
    onProgress,
  };
  if (!request.model) throw new Error('Choose a model under AI settings.');

  const run = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI, compatible: callOpenAI }[provider];
  const { text, model: usedModel } = await run(request, provider);
  const data = parseJson(text, config.label);

  const chatterIds = [...new Set(Array.isArray(data.chatter_segment_ids) ? data.chatter_segment_ids : [])]
    .map(Number)
    .filter((id) => Number.isInteger(id) && id >= 0 && id < segments.length);

  const markdown = String(data.notes_markdown || '').trim();
  if (!markdown) throw new Error(`${config.label} returned empty notes. Please try again.`);
  return {
    title: String(data.title || '').trim(),
    summary: String(data.summary || '').trim(),
    markdown,
    chatterIds,
    model: usedModel || request.model,
  };
}

// Tolerates code fences or stray prose around the JSON, which some
// OpenAI-compatible servers add when they can't enforce a schema.
function parseJson(text, label) {
  const candidates = [text, text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (data && typeof data === 'object') return data;
    } catch {
      // try the next form
    }
  }
  throw new Error(`${label}’s response couldn’t be read. Please try again.`);
}

const CUT_OFF = 'The notes were cut off before they finished. Try again, or split the lecture into shorter parts.';

// --- Anthropic (official SDK) ---------------------------------------------------

let anthropicSdk = null;

async function callAnthropic({ apiKey, model, user, onProgress }) {
  anthropicSdk ??= import(ANTHROPIC_SDK_URL).catch(() => {
    anthropicSdk = null;
    throw new Error('Couldn’t load the Claude SDK. Check your internet connection and try again.');
  });
  const { default: Anthropic } = await anthropicSdk;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const params = {
    model,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: user }],
  };
  if (!model.includes('haiku')) params.thinking = { type: 'adaptive' };
  if (model === 'claude-opus-5') {
    // Re-runs a declined request on a suitable fallback model instead of failing.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let message;
  try {
    const stream = client.beta.messages.stream(params);
    let chars = 0;
    stream.on('text', (delta) => {
      chars += delta.length;
      onProgress?.(chars);
    });
    message = await stream.finalMessage();
  } catch (err) {
    throw anthropicError(err, Anthropic);
  }

  if (message.stop_reason === 'refusal') throw new Error('Claude declined to process this transcript.');
  if (message.stop_reason === 'max_tokens') throw new Error(CUT_OFF);

  // If a fallback model took over, only the text after the last switch point is the answer.
  const lastFallback = message.content.findLastIndex((b) => b.type === 'fallback');
  const text = message.content
    .slice(lastFallback + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, model: message.model };
}

function anthropicError(err, Anthropic) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Claude rejected the API key. Check it under AI settings.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error('This API key doesn’t have access to the model.');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error('Claude doesn’t recognise that model name. Check it under AI settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Rate limit reached. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Couldn’t reach the Claude API. Check your internet connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude API error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  }
  return err;
}

// --- REST helpers (Gemini, OpenAI, compatible) ---------------------------------------

async function postJson(label, url, headers, body, keyHint = '') {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Couldn’t reach ${label.replace(/^The /, 'the ')}. Check your internet connection${label.includes('compatible') ? ', the base URL, and that the server allows this page (CORS)' : ''}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(label, res.status, data, keyHint);
  return data;
}

function httpError(label, status, data, keyHint = '') {
  const message = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '');
  const reason = data?.error?.details?.find((d) => d.reason)?.reason; // Google's machine-readable cause
  const detail = [message, reason && !message.includes(reason) ? reason : ''].filter(Boolean).join(' ');
  const badKey = /api[ _]?key/i.test(detail) && /not valid|invalid|incorrect|expired|reject|not supported/i.test(detail);
  if (status === 401 || badKey) {
    const said = detail ? ` It said: “${detail}”.` : '';
    return Object.assign(new Error(`${label} rejected the API key.${said} ${keyHint || 'Check the key under AI settings.'}`), { status, detail });
  }
  if (status === 403) return Object.assign(new Error(`This ${label} key doesn’t have access to the model.${detail ? ` (${detail})` : ''}`), { status });
  if (status === 404) return Object.assign(new Error(`${label} doesn’t recognise that model name. Check it under AI settings.`), { status });
  if (status === 429) return Object.assign(new Error(`${label} rate limit or quota reached. Wait a minute and try again.`), { status });
  return Object.assign(new Error(`${label} error (${status})${detail ? `: ${detail}` : ''}`), { status, detail });
}

// --- Google Gemini ---------------------------------------------------------------------

async function callGemini({ apiKey, model, user }) {
  const label = PROVIDERS.gemini.label;
  const url = `${GEMINI_API}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  const { additionalProperties, ...schema } = SCHEMA; // keep to the widely supported keywords
  const body = (generationConfig) => ({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  });

  const hint = PROVIDERS.gemini.keyRejectedHint;
  let data;
  try {
    data = await postJson(label, url, { 'x-goog-api-key': apiKey },
      body({ responseMimeType: 'application/json', responseJsonSchema: schema }), hint);
  } catch (err) {
    // If the model rejects the schema, JSON mode plus the prompt's instructions is enough.
    if (err.status !== 400 || !/schema/i.test(err.detail || '')) throw err;
    data = await postJson(label, url, { 'x-goog-api-key': apiKey }, body({ responseMimeType: 'application/json' }), hint);
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked this transcript (${reason}).` : 'Gemini returned no response. Please try again.');
  }
  if (candidate.finishReason === 'MAX_TOKENS') throw new Error(CUT_OFF);
  if (candidate.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(candidate.finishReason)) {
    throw new Error(`Gemini stopped early (${candidate.finishReason}).`);
  }
  const text = (candidate.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  return { text, model: data.modelVersion || model };
}

// --- OpenAI and OpenAI-compatible (Chat Completions) ----------------------------------------

async function callOpenAI({ apiKey, model, baseUrl, user }, provider) {
  const compatible = provider === 'compatible';
  const label = compatible ? 'The OpenAI-compatible API' : PROVIDERS.openai.label;
  if (compatible && !baseUrl) throw new Error('Enter the API base URL under AI settings (for example https://openrouter.ai/api/v1).');
  const url = `${compatible ? baseUrl : OPENAI_API}/chat/completions`;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const formats = [{ type: 'json_schema', json_schema: { name: 'lecture_notes', strict: true, schema: SCHEMA } }];
  // Not every compatible server supports JSON schemas; fall back to JSON mode, then plain text.
  if (compatible) formats.push({ type: 'json_object' }, null);

  let data;
  for (const [i, format] of formats.entries()) {
    const body = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    };
    if (format) body.response_format = format;
    try {
      data = await postJson(label, url, headers, body);
      break;
    } catch (err) {
      const formatProblem = err.status === 400 || err.status === 422;
      if (!formatProblem || i === formats.length - 1) throw err;
    }
  }

  const choice = data.choices?.[0];
  if (!choice) throw new Error(`${label} returned no response. Please try again.`);
  if (choice.message?.refusal) throw new Error(`The model declined: ${choice.message.refusal}`);
  if (choice.finish_reason === 'length') throw new Error(CUT_OFF);
  const content = choice.message?.content;
  const text = Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '';
  return { text, model: data.model || model };
}

// --- Model lists (for the settings suggestions) ----------------------------------------------

/** Returns model ids the key can use, or [] if the provider can't be asked. */
export async function listModels({ provider, apiKey, baseUrl }) {
  try {
    if (provider === 'gemini') {
      const res = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
      const data = await res.json();
      return (data.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
        .map((m) => m.name.replace(/^models\//, ''));
    }
    if (provider === 'openai' || provider === 'compatible') {
      const base = provider === 'openai' ? OPENAI_API : (baseUrl || '').trim().replace(/\/+$/, '');
      if (!base) return [];
      const res = await fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id).filter(Boolean);
      return provider === 'openai' ? ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|image|transcribe|tts|search/.test(id)) : ids;
    }
  } catch {
    // Suggestions are optional.
  }
  return [];
}

// --- Markdown + LaTeX -----------------------------------------------------
// A small renderer for the subset the prompt asks for. All text is escaped
// before any tags are added, so model output can't inject HTML. Math is kept
// as TeX in data-tex attributes and typeset by KaTeX afterwards (typesetMath).

const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16/dist';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Undoes JSON escapes that swallowed a TeX command's backslash, e.g. "\frac"
// parsed as a form feed + "rac" when a server couldn't enforce valid JSON.
function repairTex(tex) {
  return tex
    .replace(/\f/g, '\\f')
    .replace(/\x08/g, '\\b')
    .replace(/\t(?=[a-zA-Z])/g, '\\t')
    .replace(/\r(?=[a-zA-Z])/g, '\\r');
}

function mathHtml(tex, display) {
  const clean = repairTex(tex.trim());
  const fallback = display ? `$$${clean}$$` : `$${clean}$`; // readable if KaTeX can't load
  return `<span class="math${display ? ' math-display' : ''}" data-tex="${escapeHtml(clean)}">${escapeHtml(fallback)}</span>`;
}

function inline(s) {
  const tokens = [];
  const keep = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let out = s
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`))
    .replace(/\$\$(.+?)\$\$/g, (_, tex) => keep(mathHtml(tex, true)))
    .replace(/\\\[(.+?)\\\]/g, (_, tex) => keep(mathHtml(tex, true)))
    .replace(/\\\((.+?)\\\)/g, (_, tex) => keep(mathHtml(tex, false)))
    // Models sometimes drop the closing delimiter; treat the rest of the text as the formula.
    .replace(/\\\[(.+)$/, (_, tex) => keep(mathHtml(tex, true)))
    .replace(/\\\((.+)$/, (_, tex) => keep(mathHtml(tex, false)))
    // $…$ needs non-space just inside both dollars and no digit after the closing
    // one, so prices like "$5 and $10" stay text.
    .replace(/(^|[^\\$])\$(?=\S)([^$\n]*?\S)\$(?![\d$])/g, (_, pre, tex) => pre + keep(mathHtml(tex, false)));
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[i]);
}

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const lists = []; // stack of { type, indent }
  let html = '';
  let para = [];
  let item = null; // text lines of the current list item, rendered together so math can wrap lines
  let mathBlock = null; // { close, lines, indent } while inside a multi-line $$ … $$ block

  const flushItem = () => {
    if (item) html += inline(item.join(' '));
    item = null;
  };
  const flushPara = () => {
    flushItem();
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const closeLists = (indent = -1) => {
    flushItem();
    while (lists.length && lists.at(-1).indent > indent) html += `</li></${lists.pop().type}>`;
  };
  const displayMath = (tex, indent) => {
    flushPara();
    if (!(lists.length && indent > 0)) closeLists(); // indented equations stay inside their list item
    html += mathHtml(tex, true);
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    let m;

    if (mathBlock) {
      if (trimmed.endsWith(mathBlock.close)) {
        mathBlock.lines.push(trimmed.slice(0, -mathBlock.close.length));
        displayMath(mathBlock.lines.join('\n'), mathBlock.indent);
        mathBlock = null;
      } else {
        mathBlock.lines.push(line);
      }
    } else if (!trimmed) {
      flushPara();
    } else if ((m = trimmed.match(/^(\$\$|\\\[)(.*)$/)) && !(m[1] === '$$' && m[2].includes('$$') && !m[2].trimEnd().endsWith('$$'))) {
      const close = m[1] === '$$' ? '$$' : '\\]';
      const rest = m[2].trimEnd();
      if (rest.endsWith(close)) displayMath(rest.slice(0, -close.length), indent);
      else mathBlock = { close, lines: [rest], indent };
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
      item = [m[2]];
    } else if (trimmed.startsWith('>')) {
      flushPara(); closeLists();
      html += `<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`;
    } else if (lists.length && indent > 0) {
      // Continuation of a list item; after a blank line it starts a new line within the item.
      if (!item) {
        item = [];
        html += '<br>';
      }
      item.push(trimmed);
    } else {
      closeLists();
      para.push(trimmed);
    }
  }
  if (mathBlock) displayMath(mathBlock.lines.join('\n'), mathBlock.indent); // unterminated block
  flushPara();
  closeLists();
  return html;
}

let katexPromise = null;

function loadKatex() {
  if (!katexPromise) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${KATEX_BASE}/katex.min.css`;
    document.head.append(link);
    katexPromise = import(`${KATEX_BASE}/katex.mjs`).then((m) => m.default).catch((err) => {
      katexPromise = null;
      throw err;
    });
  }
  return katexPromise;
}

/** Typesets the math placeholders renderMarkdown produced inside `root`. */
export async function typesetMath(root) {
  const nodes = root.querySelectorAll('.math[data-tex]');
  if (!nodes.length) return;
  let katex;
  try {
    katex = await loadKatex();
  } catch {
    return; // offline: the raw TeX stays visible
  }
  for (const el of nodes) {
    if (!el.isConnected) continue;
    katex.render(el.dataset.tex, el, {
      displayMode: el.classList.contains('math-display'),
      throwOnError: false, // shows the TeX in red instead of failing
    });
  }
}
