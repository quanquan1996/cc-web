// CC-Web console SPA (ChatGPT-style): login, chats, apps.
//
// Tasks ("jobs") run on the server independently of this page. A prompt is
// submitted with POST /api/sessions/:id/jobs (idempotent via clientRequestId,
// retried on network errors); output is then followed by byte cursor, pushed
// over WS /ws/run when it works and long-polled over HTTP otherwise. Every
// batch says which cursor it starts from and is applied only if that matches
// ours, so switching transports never duplicates or drops output.
const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const isTouch = matchMedia('(pointer: coarse)').matches;
const mobileQuery = matchMedia('(max-width: 767px)');

const state = {
  me: null,
  sessions: [],
  running: new Map(), // sessionId -> running job (sidebar dots)
  current: null, // open session, null = new chat
  page: 'chat',
  cwd: localStorage.getItem('ccweb.cwd') || '',
  follower: null,
  turn: null, // live assistant turn
  sending: false,
  skipHash: null,
  dynamicEnabled: false,
};

// ---------------------------------------------------------------- icons ----
const ICONS = {
  logo: '<path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3 5.3 18.7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  edit: '<path d="M12 3.5H6a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 6 20.5h12a2.5 2.5 0 0 0 2.5-2.5v-6"/><path d="M18.4 2.9a2 2 0 0 1 2.8 2.8L12.5 14.4l-3.7.9.9-3.7Z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  menu: '<path d="M4 8h16M4 16h11"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  'arrow-up': '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  'arrow-down': '<path d="M12 5v14M18.5 12.5 12 19l-6.5-6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M18 6.5l-.8 12.6a1.5 1.5 0 0 1-1.5 1.4H8.3a1.5 1.5 0 0 1-1.5-1.4L6 6.5"/>',
  logout: '<path d="M9.5 20.5h-3a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3M16 16.5l4.5-4.5L16 7.5M20.5 12h-11"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  terminal: '<path d="m5 16.5 4.5-4.5L5 7.5M12 17h7"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  pen: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.8-4.8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/>',
  bulb: '<path d="M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.6V16h6v-.1c0-.6.3-1.2.8-1.6A6.5 6.5 0 0 0 12 2.5Z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
function paintIcons(root = document) {
  for (const e of root.querySelectorAll('[data-icon]')) {
    if (!e.querySelector('svg')) e.insertAdjacentHTML('afterbegin', icon(e.dataset.icon));
  }
}

// -------------------------------------------------------------- helpers ----
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p;
function short(v, n = 120) {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const old = btn.innerHTML;
    btn.innerHTML = btn.classList.contains('copy-btn') ? `${icon('check', 15)}Copied` : icon('check', 18);
    setTimeout(() => (btn.innerHTML = old), 1500);
  }
}

// Resolves early when the page comes back to the foreground or the network returns.
let wakeUp = () => {};
const nap = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(t);
      resolve();
    };
  });

// ------------------------------------------------------------------ API ----
async function api(method, url, body, { timeout = 30_000, signal } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(ac.signal.aborted ? 'request timed out' : `network error: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && url !== '/api/login') showLogin();
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------- markdown ----
// Escape-first renderer for the subset Claude uses: fences, headings, lists,
// quotes, tables, rules, inline code/bold/italic/links.
function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function codeBlockHTML(code, lang = '', cls = '') {
  return (
    `<div class="codeblock ${cls}"><div class="code-head"><span>${esc(lang || 'text')}</span>` +
    `<button type="button" class="copy-btn">${icon('copy', 15)}Copy</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`
  );
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const indentOf = (l) => l.match(/^\s*/)[0].length;
const isBlockStart = (l) => FENCE_RE.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l) || HR_RE.test(l);

function parseList(lines, i, base) {
  const ordered = /\d/.test(lines[i].match(LIST_RE)[2]);
  const start = ordered ? Number.parseInt(lines[i].match(LIST_RE)[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    if (!m) {
      if (!line.trim()) {
        const next = lines[i + 1];
        if (next !== undefined && LIST_RE.test(next) && indentOf(next) >= base) {
          i++;
          continue;
        }
        break;
      }
      if (items.length && indentOf(line) > base && !FENCE_RE.test(line)) {
        items[items.length - 1].text += '\n' + line.trim();
        i++;
        continue;
      }
      break;
    }
    const ind = m[1].length;
    if (ind < base) break;
    if (ind > base && items.length) {
      const sub = parseList(lines, i, ind);
      items[items.length - 1].sub += sub.html;
      i = sub.i;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    items.push({ text: line.slice(m[0].length), sub: '' });
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const html =
    `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` +
    items.map((it) => `<li>${it.text.split('\n').map(inline).join('<br>')}${it.sub}</li>`).join('') +
    `</${tag}>`;
  return { html, i };
}

function markdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(FENCE_RE))) {
      const [, ind, fence, lang] = m;
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++].slice(Math.min(ind.length, indentOf(lines[i - 1]))));
      i++; // closing fence (absent while streaming)
      out.push(codeBlockHTML(buf.join('\n'), lang));
    } else if (!line.trim()) {
      i++;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const n = Math.min(m[1].length, 4);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
    } else if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`);
    } else if (line.includes('|') && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const row = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
      const head = row(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(row(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
    } else if (LIST_RE.test(line)) {
      const r = parseList(lines, i, indentOf(line));
      out.push(r.html);
      i = r.i;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++]);
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('');
}

function renderMarkdown(node, text, cursor = false) {
  let html = markdown(text);
  if (cursor) {
    const dot = '<span class="dot-cursor"></span>';
    html = /<\/(p|li)>(<\/[uo]l>)*$/.test(html) ? html.replace(/<\/(p|li)>((<\/[uo]l>)*)$/, `${dot}</$1>$2`) : html + dot;
  }
  node.innerHTML = html;
}

// Typewriter: streamed text is revealed gradually so it reads like ChatGPT,
// catching up faster the further behind it is.
const drafts = new Set();
let drafting = false;
function animateDrafts() {
  const now = performance.now();
  for (const d of drafts) {
    const left = d.target.length - d.shown;
    if (left > 0) d.shown += Math.max(2, Math.ceil(left / 12));
    const caught = d.shown >= d.target.length;
    if (caught && d.final) {
      renderMarkdown(d.el, d.target);
      drafts.delete(d);
    } else if (now - d.paintedAt > 30) {
      renderMarkdown(d.el, d.target.slice(0, d.shown), true);
      d.paintedAt = now;
    }
  }
  if (drafts.size) requestAnimationFrame(animateDrafts);
  else drafting = false;
}
function startDraft(d) {
  drafts.add(d);
  if (!drafting) {
    drafting = true;
    requestAnimationFrame(animateDrafts);
  }
}

// ----------------------------------------------------------- tool steps ----
function toolArg(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input?.[k]).find((v) => typeof v === 'string' && v);
  switch (name) {
    case 'Bash': return pick('command');
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep': case 'Glob': return [pick('pattern'), input?.path].filter(Boolean).join('  in ');
    case 'WebFetch': return pick('url');
    case 'WebSearch': return pick('query');
    case 'Task': case 'Agent': return pick('description', 'prompt');
    case 'TodoWrite': return Array.isArray(input?.todos) ? `${input.todos.length} todos` : '';
    default: return Object.values(input ?? {}).find((v) => typeof v === 'string') ?? '';
  }
}
function toolIcon(name) {
  if (name === 'Bash') return 'terminal';
  if (name === 'Read') return 'file';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'pen';
  if (['Grep', 'Glob'].includes(name)) return 'search';
  if (['WebFetch', 'WebSearch'].includes(name)) return 'globe';
  if (name === 'TodoWrite') return 'list';
  return 'tool';
}
function toolVerb(name) {
  return { Bash: 'Running', Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing', Grep: 'Searching', Glob: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching the web', TodoWrite: 'Updating todos', Task: 'Delegating', Agent: 'Delegating' }[name] ?? `Using ${name}`;
}

// ------------------------------------------------------------- the chat ----
const thread = $('#thread');
const scroller = $('#scroller');
let pinned = true;

scroller.addEventListener('scroll', () => {
  pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  $('#to-bottom').hidden = pinned;
});
new ResizeObserver(() => {
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
}).observe(thread);
function scrollToBottom() {
  pinned = true;
  scroller.scrollTop = scroller.scrollHeight;
  $('#to-bottom').hidden = true;
}

function actionButton(name, title, onClick) {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = title;
  b.innerHTML = icon(name, 18);
  b.onclick = () => onClick(b);
  return b;
}

function renderUser(text, pending = false) {
  const t = el('div', 'turn user');
  const bubble = el('div', 'bubble' + (pending ? ' pending' : ''), text);
  const actions = el('div', 'actions');
  actions.append(actionButton('copy', 'Copy', (b) => copyText(text, b)));
  t.append(bubble, actions);
  thread.append(t);
  return t;
}

/** One assistant reply: markdown text inline, tool calls and thinking folded
 *  into "steps" groups. Fed either complete history blocks or live job events. */
class AssistantTurn {
  constructor(live) {
    this.live = live;
    this.el = el('div', 'turn assistant');
    this.body = el('div', 'a-body');
    this.wait = el('span', 'dot-cursor');
    this.el.append(this.body);
    this.texts = [];
    this.tools = new Map(); // tool_use id -> step
    this.groups = [];
    this.draft = null;
    this.result = null;
    for (const t of thread.querySelectorAll('.turn.assistant.last')) t.classList.remove('last');
    this.el.classList.add('last');
    thread.append(this.el);
    this.refresh();
  }

  group() {
    const g = this.groups[this.groups.length - 1];
    if (g && this.body.lastElementChild === g.el) return g;
    const d = el('details', 'steps');
    const sum = el('summary');
    const label = el('span', 'label');
    sum.append(label);
    sum.insertAdjacentHTML('beforeend', `<span class="chev">${icon('chev', 16)}</span>`);
    const body = el('div', 'steps-body');
    d.append(sum, body);
    this.body.append(d);
    const ng = { el: d, label, body, tools: [], thinking: 0, thinkingLive: false };
    this.groups.push(ng);
    return ng;
  }

  addText(text) {
    const d = el('div', 'md');
    renderMarkdown(d, text);
    this.body.append(d);
    this.texts.push(text);
  }

  addThinking(text) {
    const g = this.group();
    g.thinking += 1;
    g.thinkingLive = false;
    const s = el('details', 'step thinking');
    const sum = el('summary');
    sum.innerHTML = `<span class="s-icon">${icon('bulb', 16)}</span><span class="s-name">Thought</span><span class="s-arg"></span>`;
    sum.querySelector('.s-arg').textContent = short(text, 100);
    s.append(sum, el('div', 'md', text));
    g.body.append(s);
  }

  addTool(b) {
    const g = this.group();
    const s = el('details', 'step');
    const sum = el('summary');
    sum.innerHTML = `<span class="s-icon">${icon(toolIcon(b.name), 16)}</span><span class="s-name"></span><span class="s-arg"></span><span class="s-status pending"></span>`;
    sum.querySelector('.s-name').textContent = b.name;
    sum.querySelector('.s-arg').textContent = short(toolArg(b.name, b.input));
    const body = el('div', 'step-body');
    const bash = b.name === 'Bash' && typeof b.input?.command === 'string';
    const input = bash ? b.input.command + (b.input.description ? `\n# ${b.input.description}` : '') : JSON.stringify(b.input, null, 2);
    body.innerHTML = `<div class="io-label">Input</div>${codeBlockHTML(input, bash ? 'bash' : 'json', 'io')}`;
    s.append(sum, body);
    g.body.append(s);
    const step = { el: s, status: sum.querySelector('.s-status'), body, name: b.name, arg: toolArg(b.name, b.input), done: false };
    g.tools.push(step);
    this.tools.set(b.id, step);
    if (b.result) this.toolResult(b.id, b.result);
  }

  toolResult(id, r) {
    let step = this.tools.get(id);
    if (!step) {
      // Result whose tool_use is outside the loaded history window.
      this.addTool({ id, name: 'result', input: {} });
      step = this.tools.get(id);
    }
    const n = r.text ? r.text.split('\n').length : 0;
    step.done = true;
    step.status.className = `s-status ${r.isError ? 'err' : 'ok'}`;
    step.status.textContent = r.isError ? 'error' : `${n} line${n === 1 ? '' : 's'}`;
    step.body.insertAdjacentHTML(
      'beforeend',
      `<div class="io-label">${r.isError ? 'Error' : 'Output'}</div>` +
        codeBlockHTML((r.text || '(no output)') + (r.truncated ? '\n… (truncated)' : ''), 'output', `io${r.isError ? ' err' : ''}`),
    );
    if (r.isError) step.el.classList.add('error');
  }

  blocks(blocks) {
    for (const b of blocks) {
      if (b.type === 'text') {
        if (this.draft) {
          // The complete block replaces what was streamed so far.
          this.draft.target = b.text;
          this.draft.final = true;
          this.texts.push(b.text);
          this.draft = null;
        } else this.addText(b.text);
      } else if (b.type === 'thinking') this.addThinking(b.text);
      else if (b.type === 'tool_use') this.addTool(b);
      else if (b.type === 'tool_result') this.toolResult(b.toolUseId, b);
      else if (b.type === 'image') this.addText('*[image]*');
    }
  }

  /** One view event from /api/jobs/:id/events (see jobs.js viewEvent). */
  event(e) {
    if (e.t === 'delta') {
      if (e.kind === 'thinking') {
        this.group().thinkingLive = true;
        return;
      }
      if (!this.draft) {
        const d = el('div', 'md');
        this.body.append(d);
        this.draft = { el: d, target: '', shown: 0, final: false, paintedAt: 0 };
        startDraft(this.draft);
      }
      this.draft.target += e.text;
    } else if (e.t === 'assistant' || e.t === 'user') this.blocks(e.blocks);
    else if (e.t === 'result') this.result = e;
  }

  refresh() {
    const lastChild = [...this.body.children].filter((c) => c !== this.wait).pop();
    for (const g of this.groups) {
      const working = this.live && g.el === lastChild;
      g.el.classList.toggle('running', working);
      const pending = g.tools.filter((s) => !s.done).pop();
      let label;
      if (working && pending) label = `${toolVerb(pending.name)}${pending.arg ? ` ${short(pending.arg, 60)}` : ''}…`;
      else if (working) label = g.thinkingLive ? 'Thinking…' : 'Working…';
      else if (g.tools.length) {
        const names = [...new Set(g.tools.map((s) => s.name))];
        label = `Used ${g.tools.length} tool${g.tools.length === 1 ? '' : 's'} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
      } else label = 'Thought';
      g.label.textContent = label;
    }
    const streaming = this.draft && !this.draft.final;
    const busyGroup = this.groups.some((g) => g.el.classList.contains('running'));
    if (this.live && !streaming && !busyGroup) this.body.append(this.wait);
    else this.wait.remove();
  }

  /** Job reached a final state: stop indicators, add status note and actions. */
  finish(job) {
    this.live = false;
    if (this.draft) {
      this.draft.final = true;
      this.texts.push(this.draft.target);
      this.draft = null;
    }
    for (const step of this.tools.values()) {
      if (!step.done) {
        step.status.className = 's-status';
        step.status.textContent = job?.status === 'cancelled' ? 'stopped' : '—';
      }
    }
    this.refresh();
    if (job?.status === 'cancelled') this.body.append(el('div', 'note', 'Stopped'));
    else if (job?.status === 'failed') {
      const n = el('div', 'note err', job.error || 'The task failed');
      if (job.stderr) n.append(el('pre', null, job.stderr));
      this.body.append(n);
    }
    this.addActions(job);
  }

  addActions(job) {
    this.el.querySelector('.actions')?.remove();
    const a = el('div', 'actions');
    a.append(actionButton('copy', 'Copy', (b) => copyText(this.texts.join('\n\n'), b)));
    // Wall-clock: one job can contain several claude turns (e.g. after a background task).
    const ms = job?.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : job?.result?.durationMs;
    const cost = job?.result?.costUsd;
    const meta = [ms ? `${(ms / 1000).toFixed(1)}s` : '', typeof cost === 'number' ? `$${cost.toFixed(4)}` : ''].filter(Boolean).join(' · ');
    if (meta) a.append(el('span', 'meta', meta));
    this.el.append(a);
  }
}

function renderHistory(messages) {
  let turn = null;
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const rest = m.blocks.filter((b) => b.type !== 'text');
      if (text) {
        turn?.finish(null);
        turn = null;
        renderUser(text);
      }
      if (rest.length) (turn ??= new AssistantTurn(false)).blocks(rest);
    } else {
      (turn ??= new AssistantTurn(false)).blocks(m.blocks);
    }
  }
  turn?.finish(null);
}

// ------------------------------------------------------------ transport ----
const transport = {
  ws: null,
  open: false,
  retry: 0,
  timer: null,
  lastMsg: 0,
  probeAt: 0,
  forcePoll: params.get('transport') === 'poll' || localStorage.getItem('ccweb.transport') === 'poll',
};

function updateConn(mode) {
  const c = $('#conn');
  const m = mode ?? (transport.open ? 'ws' : state.follower?.fails ? 'offline' : 'poll');
  c.className = `conn ${m}`;
  c.title = { ws: 'Live (WebSocket)', poll: 'Live (HTTP polling)', offline: 'Offline — retrying' }[m];
  c.dataset.mode = m;
}

function wsSend(msg) {
  if (transport.open) transport.ws.send(JSON.stringify(msg));
}

function connectWs() {
  clearTimeout(transport.timer);
  if (transport.forcePoll || transport.ws || !state.me) return;
  let ws;
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/run`);
  } catch {
    return scheduleWs();
  }
  transport.ws = ws;
  const openTimer = setTimeout(() => ws.readyState !== 1 && dropWs(ws), 8000);
  ws.onopen = () => {
    if (transport.ws !== ws) return;
    clearTimeout(openTimer);
    transport.open = true;
    transport.retry = 0;
    transport.lastMsg = Date.now();
    updateConn();
    state.follower?.onWsOpen();
  };
  ws.onmessage = (e) => {
    if (transport.ws !== ws) return;
    transport.lastMsg = Date.now();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'events') state.follower?.onWsBatch(msg);
    else if (msg.type === 'error') state.follower?.onWsError(msg);
  };
  ws.onclose = () => {
    clearTimeout(openTimer);
    dropWs(ws);
  };
  ws.onerror = () => {};
}

/** Forget a socket immediately (a dead mobile connection may take minutes to report close). */
function dropWs(ws) {
  if (transport.ws !== ws) return;
  transport.ws = null;
  transport.open = false;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  updateConn();
  state.follower?.onWsClose();
  scheduleWs();
}

function scheduleWs() {
  clearTimeout(transport.timer);
  if (transport.forcePoll || !state.me) return;
  transport.timer = setTimeout(connectWs, Math.min(30_000, 1000 * 2 ** transport.retry++));
}

// The server pushes at least one batch every 25 s to a subscribed socket; silence means it is dead.
setInterval(() => {
  const f = state.follower;
  if (!transport.open || !f?.subscribed) return;
  const now = Date.now();
  if (now - transport.lastMsg > 40_000 || (transport.probeAt && transport.lastMsg < transport.probeAt && now - transport.probeAt > 6000)) {
    dropWs(transport.ws);
  }
}, 2000);

/** Follows one job's output from `cursor` until it is finished, over WS or HTTP. */
class Follower {
  constructor(job, onBatch) {
    this.job = job;
    this.jobId = job.id;
    this.cursor = 0;
    this.onBatch = onBatch;
    this.stopped = false;
    this.subscribed = false;
    this.polling = false;
    this.pollAc = null;
    this.fails = 0;
  }

  start() {
    if (transport.open) this.subscribe();
    else this.poll();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pollAc?.abort();
    if (this.subscribed) wsSend({ type: 'unsubscribe' });
    this.subscribed = false;
  }

  apply(b) {
    if (this.stopped) return false;
    if (b.from !== this.cursor) return false;
    this.cursor = b.cursor;
    this.job = b.job;
    this.onBatch(b);
    if (b.job.status !== 'running' && !b.more) this.stop();
    return true;
  }

  subscribe() {
    if (this.stopped || !transport.open) return;
    this.subscribed = true;
    wsSend({ type: 'subscribe', jobId: this.jobId, cursor: this.cursor });
  }

  onWsOpen() {
    this.pollAc?.abort();
    this.subscribe();
  }

  onWsBatch(b) {
    if (b.jobId !== this.jobId || this.stopped) return;
    // A poll got there first: restart the server-side stream at our cursor.
    if (!this.apply(b) && b.from !== this.cursor) this.subscribe();
  }

  onWsError(m) {
    if (m.jobId !== this.jobId) return;
    this.subscribed = false;
    this.poll();
  }

  onWsClose() {
    this.subscribed = false;
    this.poll();
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    while (!this.stopped && !transport.open) {
      const ac = (this.pollAc = new AbortController());
      try {
        const b = await api('GET', `/api/jobs/${this.jobId}/events?cursor=${this.cursor}&wait=20`, null, { timeout: 40_000, signal: ac.signal });
        if (this.fails) {
          this.fails = 0;
          updateConn();
        }
        this.apply(b);
      } catch (err) {
        if (this.stopped || transport.open || ac.signal.aborted) {
          if (ac.signal.aborted && !this.stopped && !transport.open) continue; // aborted by a wake-up
          break;
        }
        if (err.status === 404) {
          this.stop();
          break;
        }
        this.fails++;
        updateConn('offline');
        await nap(Math.min(15_000, 1000 * 2 ** Math.min(this.fails, 4)));
      }
    }
    this.polling = false;
    if (!this.stopped && transport.open && !this.subscribed) this.subscribe();
  }

  /** Page came back to the foreground: verify the channel instead of trusting it. */
  kick() {
    if (this.stopped) return;
    if (transport.open) {
      transport.probeAt = Date.now();
      this.subscribe();
    } else this.pollAc?.abort();
  }
}

function stopFollower() {
  state.follower?.stop();
  state.follower = null;
}

function attach(job, turn) {
  stopFollower();
  state.turn = turn;
  const f = new Follower(job, (b) => {
    for (const e of b.events) turn.event(e);
    turn.refresh();
    if (b.job.status !== 'running' && !b.more) {
      turn.finish(b.job);
      if (state.turn === turn) state.turn = null;
      state.running.delete(b.job.sessionId);
      renderSidebar();
    }
    updateComposer();
  });
  state.follower = f;
  if (job.status === 'running') state.running.set(job.sessionId, job);
  updateComposer();
  updateConn();
  f.start();
}

const jobRunning = () => state.follower?.job.status === 'running' && !state.follower.stopped;

// ---------------------------------------------------------------- chats ----
let openToken = 0;

function setChrome() {
  const s = state.current;
  const onChat = state.page === 'chat';
  $('#page-chat').hidden = !onChat;
  $('#page-apps').hidden = onChat;
  $('#top-title').textContent = onChat ? (s ? s.title : 'CC-Web') : 'Apps';
  $('#cwd-chip').textContent = onChat && s ? s.cwd : '';
  $('#cwd-chip').title = s?.cwd ?? '';
  $('#chat-menu-btn').hidden = !(onChat && s);
  $('#nav-apps').classList.toggle('active', !onChat);
  const pill = $('#cwd-pick');
  pill.classList.toggle('locked', Boolean(s));
  const cwd = s ? s.cwd : state.cwd;
  $('#cwd-label').textContent = cwd ? basename(cwd) : 'Choose folder';
  pill.title = cwd || 'Choose a working directory';
  $('#disclaimer').textContent = 'Claude Code can make mistakes. Tasks keep running when you close this page.';
  renderSidebar();
}

function updateEmpty() {
  const empty = state.page === 'chat' && !state.current && !thread.children.length;
  $('#empty').hidden = !empty;
  $('#page-chat').classList.toggle('is-empty', empty);
}

function clearThread() {
  thread.replaceChildren();
  drafts.clear();
  state.turn = null;
  pinned = true;
}

function newChat() {
  openToken++;
  stopFollower();
  state.current = null;
  state.page = 'chat';
  clearThread();
  setChrome();
  updateEmpty();
  updateComposer();
  if (!isTouch) $('#prompt').focus();
}

async function openChat(id) {
  const token = ++openToken;
  stopFollower();
  clearThread();
  state.page = 'chat';
  let s = state.sessions.find((x) => x.id === id);
  if (!s) {
    await loadSessions().catch(() => {});
    s = state.sessions.find((x) => x.id === id);
  }
  if (token !== openToken) return;
  if (!s) {
    toast('Chat not found');
    location.hash = '#/';
    return;
  }
  state.current = s;
  setChrome();
  updateEmpty();
  updateComposer();
  const loading = el('div', 'note', 'Loading…');
  thread.append(loading);

  const [hist, jobs] = await Promise.all([
    api('GET', `/api/sessions/${id}/history`, null, { timeout: 45_000 }).catch((err) => ({ error: err })),
    api('GET', `/api/sessions/${id}/jobs?limit=1`).catch((err) => ({ error: err })),
  ]);
  if (token !== openToken) return;
  loading.remove();
  if (hist.error && jobs.error) {
    const n = el('div', 'note err', `Could not load this chat: ${hist.error.message}`);
    const retry = el('button', 'btn-ghost small', 'Retry');
    retry.style.marginTop = '.5rem';
    retry.onclick = () => openChat(id);
    n.append(el('br'), retry);
    thread.append(n);
    return;
  }
  // The latest job is rendered from its own event log; history covers everything before it.
  const job = jobs.jobs?.[0] ?? null;
  const cutoff = job ? Date.parse(job.startedAt) : Infinity;
  if (hist.truncated) thread.append(el('div', 'note', 'Older messages are not shown.'));
  renderHistory((hist.messages ?? []).filter((m) => !m.timestamp || Date.parse(m.timestamp) < cutoff));
  if (job) {
    renderUser(job.prompt);
    attach(job, new AssistantTurn(job.status === 'running'));
  }
  updateEmpty();
  scrollToBottom();
}

async function submitJob(sessionId, prompt) {
  const clientRequestId = uuid();
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('POST', `/api/sessions/${sessionId}/jobs`, { prompt, clientRequestId }, { timeout: 20_000 });
    } catch (err) {
      // No status = the request or its response got lost; retrying with the same id is safe.
      if (err.status || attempt >= 6) throw err;
      await nap(Math.min(8000, 1000 * 2 ** attempt));
    }
  }
}

async function send() {
  const ta = $('#prompt');
  const text = ta.value.trim();
  if (!text || state.sending || jobRunning()) return;
  let s = state.current;
  if (!s && !state.cwd) {
    toast('Choose a working directory first');
    openDirPicker();
    return;
  }
  state.sending = true;
  updateComposer();
  try {
    if (!s) {
      s = await api('POST', '/api/sessions', { cwd: state.cwd, title: text.replace(/\s+/g, ' ').slice(0, 60) });
      state.sessions.unshift(s);
      state.current = s;
      state.skipHash = `#/c/${s.id}`;
      location.hash = state.skipHash;
      setChrome();
    }
    openToken++; // a late openChat() must not wipe this turn
    ta.value = '';
    autosize();
    const userTurn = renderUser(text, true);
    const turn = new AssistantTurn(true);
    updateEmpty();
    scrollToBottom();
    let res;
    try {
      res = await submitJob(s.id, text);
    } catch (err) {
      userTurn.remove();
      turn.el.remove();
      if (!ta.value) ta.value = text;
      autosize();
      if (err.status === 409 && err.data?.job) {
        toast('A task is already running in this chat');
        renderUser(err.data.job.prompt);
        attach(err.data.job, new AssistantTurn(true));
      } else toast(`Could not send: ${err.message}`);
      return;
    }
    userTurn.querySelector('.bubble').classList.remove('pending');
    attach(res.job, turn);
    s.lastRunAt = res.job.startedAt;
    renderSidebar();
  } catch (err) {
    toast(err.message);
  } finally {
    state.sending = false;
    updateComposer();
  }
}

async function stopJob() {
  const job = state.follower?.job;
  if (!job || job.status !== 'running') return;
  $('#stop').disabled = true;
  for (let i = 0; i < 4; i++) {
    try {
      await api('POST', `/api/jobs/${job.id}/cancel`);
      break;
    } catch (err) {
      if (err.status) {
        toast(err.message);
        break;
      }
      await sleep(1000 * (i + 1));
    }
  }
}

// ------------------------------------------------------------- composer ----
function autosize() {
  const ta = $('#prompt');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function updateComposer() {
  const running = jobRunning() || state.sending;
  $('#send').hidden = running;
  $('#stop').hidden = !running;
  $('#stop').disabled = !jobRunning();
  $('#send').disabled = !$('#prompt').value.trim();
}

// ------------------------------------------------------------- sidebar -----
function dayGroup(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  if (diff <= 0) return 'Today';
  if (diff <= 1) return 'Yesterday';
  if (diff <= 7) return 'Previous 7 Days';
  if (diff <= 30) return 'Previous 30 Days';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function renderSidebar() {
  const list = $('#session-list');
  list.replaceChildren();
  $('#nav-new').classList.toggle('active', state.page === 'chat' && !state.current);
  if (!state.sessions.length) {
    list.append(el('div', 'sb-empty', 'No chats yet'));
    return;
  }
  const sorted = [...state.sessions].sort((a, b) => (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt));
  let group = null;
  for (const s of sorted) {
    const g = dayGroup(s.lastRunAt ?? s.createdAt);
    if (g !== group) {
      group = g;
      list.append(el('div', 'sb-group', g));
    }
    const a = el('a', 'sb-item sb-chat' + (state.page === 'chat' && state.current?.id === s.id ? ' active' : ''));
    a.href = `#/c/${s.id}`;
    a.title = `${s.title}\n${s.cwd}`;
    a.append(el('span', 'title', s.title));
    if (state.running.has(s.id)) a.append(el('span', 'run-dot'));
    const more = el('button', 'more');
    more.type = 'button';
    more.title = 'Options';
    more.innerHTML = icon('more', 18);
    more.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      popMenu(more, [{ label: 'Delete', icon: 'trash', danger: true, run: () => deleteChat(s) }]);
    };
    a.append(more);
    list.append(a);
  }
}

function popMenu(anchor, items) {
  document.querySelector('.menu.pop')?.remove();
  const m = el('div', 'menu pop');
  for (const it of items) {
    const b = el('button', 'menu-item' + (it.danger ? ' danger' : ''));
    b.innerHTML = icon(it.icon, 18);
    b.append(it.label);
    b.onclick = () => {
      m.remove();
      it.run();
    };
    m.append(b);
  }
  const r = anchor.getBoundingClientRect();
  m.style.position = 'fixed';
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - 60)}px`;
  m.style.left = `${Math.min(r.left, innerWidth - 200)}px`;
  m.style.right = 'auto';
  document.body.append(m);
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
}

async function deleteChat(s) {
  if (!confirm(`Delete chat "${s.title}"?${state.running.has(s.id) ? '\nIts running task will be stopped.' : ''}`)) return;
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
  } catch (err) {
    return toast(err.message);
  }
  state.sessions = state.sessions.filter((x) => x.id !== s.id);
  if (state.current?.id === s.id) location.hash = '#/';
  renderSidebar();
}

async function loadSessions() {
  const { sessions } = await api('GET', '/api/sessions');
  state.sessions = sessions;
  if (state.current) state.current = sessions.find((s) => s.id === state.current.id) ?? state.current;
  renderSidebar();
}

/** Sidebar running dots; also notices a task started for this chat elsewhere. */
async function refreshRunning() {
  if (!state.me) return;
  let jobs;
  try {
    ({ jobs } = await api('GET', '/api/jobs?status=running'));
  } catch {
    return;
  }
  state.running = new Map(jobs.map((j) => [j.sessionId, j]));
  const cur = state.current && state.running.get(state.current.id);
  if (cur && state.page === 'chat' && !state.sending && state.follower?.jobId !== cur.id) openChat(state.current.id);
  if (jobs.some((j) => !state.sessions.find((s) => s.id === j.sessionId))) loadSessions().catch(() => {});
  else renderSidebar();
}

function setSidebar(open) {
  const layout = $('#view-main');
  if (mobileQuery.matches) layout.classList.toggle('sb-open', open);
  else {
    layout.classList.toggle('sb-collapsed', !open);
    localStorage.setItem('ccweb.sb', open ? '1' : '0');
  }
}

// --------------------------------------------------------- folder picker ---
let dirPath = null;
function openDirPicker() {
  $('#dir-modal').hidden = false;
  browse(state.cwd || null);
}

async function browse(dir) {
  const list = $('#dir-list');
  $('#dir-error').textContent = '';
  list.replaceChildren(el('div', 'dir-sec', 'Loading…'));
  const item = (label, p, ic = 'folder') => {
    const b = el('button', 'dir-item');
    b.type = 'button';
    b.innerHTML = icon(ic, 18);
    b.append(el('span', 'grow', label));
    b.onclick = () => browse(p);
    return b;
  };
  try {
    if (!dir) {
      const { roots } = await api('GET', '/api/dirs');
      dirPath = null;
      list.replaceChildren();
      $('#dir-path').textContent = 'Allowed roots';
      $('#dir-up').disabled = true;
      $('#dir-pick').disabled = true;
      const recent = [...new Set(state.sessions.map((s) => s.cwd))].slice(0, 6);
      if (recent.length) {
        list.append(el('div', 'dir-sec', 'Recent'));
        for (const r of recent) list.append(item(r, r));
      }
      list.append(el('div', 'dir-sec', 'Roots'));
      for (const r of roots) list.append(item(r, r));
      return;
    }
    const data = await api('GET', `/api/dirs?root=${encodeURIComponent(dir)}`);
    dirPath = data.path;
    list.replaceChildren();
    $('#dir-path').textContent = data.path;
    $('#dir-up').disabled = false;
    $('#dir-up').dataset.parent = data.parent ?? '';
    $('#dir-pick').disabled = false;
    if (!data.dirs.length) list.append(el('div', 'dir-sec', 'No subfolders'));
    for (const d of data.dirs) list.append(item(d.name + (d.symlink ? ' ↪' : ''), d.path));
  } catch (err) {
    if (dir) return browse(null);
    list.replaceChildren();
    $('#dir-error').textContent = err.message;
  }
}

// ----------------------------------------------------------------- apps ----
const appJob = { id: null, seen: 0 };

async function loadApps() {
  let data;
  try {
    data = await api('GET', '/api/apps');
    $('#apps-unavailable').hidden = true;
  } catch (err) {
    data = err.data ?? { apps: [] };
    $('#apps-unavailable').hidden = false;
  }
  state.dynamicEnabled = Boolean(data.dynamicEnabled);
  updateDynamicWarning();
  const grid = $('#app-list');
  grid.replaceChildren();
  const apps = data.apps ?? [];
  $('#apps-empty').hidden = apps.length > 0;
  for (const a of apps) {
    const card = el('div', 'app-card');
    card.append(el('strong', null, a.name));
    card.append(el('div', 'muted small', `${a.type} · ${a.status}${a.port ? ` · port ${a.port}` : ''}${a.error ? ` · ${a.error}` : ''}`));
    const row = el('div', 'row');
    const open = el('a', 'btn-primary small', 'Open');
    open.style.height = '32px';
    open.href = a.mountPath;
    open.target = '_blank';
    open.rel = 'noopener';
    const del = el('button', 'btn-ghost small', 'Delete');
    del.onclick = async () => {
      if (!confirm(`Delete app "${a.name}" and all its files?`)) return;
      await api('DELETE', `/api/apps/${encodeURIComponent(a.name)}`).catch((e) => toast(e.message));
      setTimeout(loadApps, 800);
    };
    row.append(open, el('span', 'grow'), del);
    card.append(row);
    grid.append(card);
  }
}

function updateDynamicWarning() {
  $('#dynamic-warning').hidden = !($('#new-app [name=type]').value === 'dynamic' && !state.dynamicEnabled);
}

async function pollAppJob() {
  if (!appJob.id) return;
  let job;
  try {
    job = await api('GET', `/api/apps/jobs/${appJob.id}?since=${appJob.seen}`);
  } catch {
    return setTimeout(pollAppJob, 3000);
  }
  const log = $('#job-log');
  if (job.lines.length) {
    log.textContent += job.lines.join('\n') + '\n';
    log.scrollTop = log.scrollHeight;
  }
  appJob.seen = job.total;
  $('#job-status').textContent = job.status;
  $('#job-status').className = 'badge' + (job.status === 'running' ? ' live' : '');
  $('#job-cancel').hidden = job.status !== 'running';
  if (job.status === 'running') setTimeout(pollAppJob, 1500);
  else {
    appJob.id = null;
    loadApps();
  }
}

function showApps() {
  openToken++;
  stopFollower();
  state.page = 'apps';
  state.current = null;
  setChrome();
  loadApps().catch(() => {});
}

// --------------------------------------------------------------- routing ---
function route() {
  if (!state.me) return;
  if (state.skipHash && location.hash === state.skipHash) {
    state.skipHash = null;
    return;
  }
  document.querySelector('.menu.pop')?.remove();
  $('#chat-menu').hidden = true;
  if (mobileQuery.matches) setSidebar(false);
  const h = location.hash;
  const m = h.match(/^#\/c\/([0-9a-f-]{36})$/);
  if (m) openChat(m[1]);
  else if (h === '#/apps') showApps();
  else newChat();
}

function showLogin() {
  state.me = null;
  stopFollower();
  if (transport.ws) dropWs(transport.ws);
  clearTimeout(transport.timer);
  $('#view-main').hidden = true;
  $('#view-login').hidden = false;
  $('#login-form [name=user]').focus();
}

async function showMain(me) {
  state.me = me;
  state.dynamicEnabled = Boolean(me.dynamicAppsEnabled);
  $('#view-login').hidden = true;
  $('#view-main').hidden = false;
  $('#user-name').textContent = me.user;
  $('#avatar').textContent = (me.user[0] || '?').toUpperCase();
  if (!mobileQuery.matches && localStorage.getItem('ccweb.sb') === '0') $('#view-main').classList.add('sb-collapsed');
  updateConn(transport.forcePoll ? 'poll' : undefined);
  connectWs();
  await loadSessions().catch(() => {});
  route();
  refreshRunning();
  const next = params.get('next');
  if (next && next.startsWith('/apps/')) location.href = next;
}

// ---------------------------------------------------------------- wiring ---
paintIcons();
$('.login-logo').innerHTML = icon('logo', 44);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('POST', '/api/login', { user: f.get('user'), pass: f.get('pass') });
    e.target.reset();
    showMain(await api('GET', '/api/me'));
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

window.addEventListener('hashchange', route);
$('#sb-close').addEventListener('click', () => setSidebar(false));
$('#sb-open').addEventListener('click', () => setSidebar(true));
$('#sb-menu').addEventListener('click', () => setSidebar(true));
$('#backdrop').addEventListener('click', () => setSidebar(false));
$('#backdrop').hidden = false; // shown via .sb-open on mobile only
for (const a of document.querySelectorAll('.sb-nav a, #top-new')) {
  // Clicking "New chat" while already on it should still reset the view.
  a.addEventListener('click', () => {
    if (location.hash === a.getAttribute('href') || (a.getAttribute('href') === '#/' && !location.hash)) route();
  });
}

const ta = $('#prompt');
ta.addEventListener('input', () => {
  autosize();
  updateComposer();
});
ta.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter breaks the line; IME composition and touch keyboards insert newlines.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !isTouch) {
    e.preventDefault();
    send();
  }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('#composer').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.classList.contains('composer-bar')) ta.focus();
});
$('#stop').addEventListener('click', stopJob);
$('#to-bottom').addEventListener('click', scrollToBottom);
$('#cwd-pick').addEventListener('click', () => !state.current && openDirPicker());

$('#chat-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#chat-menu').hidden = !$('#chat-menu').hidden;
});
document.addEventListener('click', () => ($('#chat-menu').hidden = true));
$('#delete-chat').addEventListener('click', () => state.current && deleteChat(state.current));

thread.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (btn) copyText(btn.closest('.codeblock').querySelector('pre').innerText, btn);
});

$('#dir-close').addEventListener('click', () => ($('#dir-modal').hidden = true));
$('#dir-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#dir-modal').hidden = true;
});
$('#dir-up').addEventListener('click', (e) => browse(e.currentTarget.dataset.parent || null));
$('#dir-pick').addEventListener('click', () => {
  if (!dirPath) return;
  state.cwd = dirPath;
  localStorage.setItem('ccweb.cwd', dirPath);
  $('#dir-modal').hidden = true;
  setChrome();
  ta.focus();
});

$('#new-app [name=type]').addEventListener('change', updateDynamicWarning);
$('#new-app').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#app-error').textContent = '';
  try {
    const res = await api('POST', '/api/apps', { name: f.get('name'), type: f.get('type'), prompt: f.get('prompt') });
    appJob.id = res.jobId;
    appJob.seen = 0;
    $('#job-box').hidden = false;
    $('#job-title').textContent = `Generating ${res.name} (${res.type}) → ${res.url}`;
    $('#job-log').textContent = '';
    pollAppJob();
  } catch (err) {
    $('#app-error').textContent = err.message;
  }
});
$('#job-cancel').addEventListener('click', () => {
  if (appJob.id) api('POST', `/api/apps/jobs/${appJob.id}/cancel`).catch(() => {});
});
$('#apps-refresh').addEventListener('click', () => loadApps());

// Phones suspend pages in the background: re-check everything on return.
function resume() {
  if (!state.me) return;
  wakeUp();
  state.follower?.kick();
  if (!transport.ws) connectWs();
  refreshRunning();
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && resume());
window.addEventListener('online', resume);
window.addEventListener('pageshow', (e) => e.persisted && resume());
setInterval(() => document.visibilityState === 'visible' && refreshRunning(), 20_000);

// Boot: are we already logged in?
api('GET', '/api/me')
  .then(showMain)
  .catch(() => showLogin());
