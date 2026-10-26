// CC-Web console SPA: login, sessions, live console over WS /ws/run, apps.
const $ = (sel) => document.querySelector(sel);

const state = {
  sessions: [],
  current: null, // selected session
  running: false,
  dirPath: null,
  dynamicEnabled: false,
  jobId: null,
  jobSeen: 0,
};

// ---------------------------------------------------------------- API ----
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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

// --------------------------------------------------------------- chat ----
// Conversation rendered as DOM, close to Claude Code's own UI: user/assistant
// text inline, tool calls and thinking collapsed in <details>. History comes
// from GET /api/sessions/:id/history, live turns from WS /ws/run; both are
// normalized to the same block shape (see packages/core/src/history.js).
const chat = $('#chat');
const tools = new Map(); // tool_use id -> { details, status, body }
let turn = null; // assistant turn currently being appended to
let historyToken = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Append while keeping the view pinned to the bottom if it already was.
function append(node, parent = chat) {
  const pinned = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  parent.append(node);
  if (pinned) chat.scrollTop = chat.scrollHeight;
}

function clearChat() {
  chat.replaceChildren();
  tools.clear();
  turn = null;
}

const note = (text, cls = '') => append(el('div', `note ${cls}`, text));

function short(v, n = 120) {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Minimal, escape-first markdown: fenced code, inline code, bold, headings.
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function markdown(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```[^\n]*\n([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2) {
      const block = el('pre', 'code');
      block.append(el('code', null, part.replace(/\n$/, '')));
      frag.append(block);
      return;
    }
    if (!part.trim()) return;
    const div = el('div', 'md');
    div.innerHTML = esc(part.replace(/^\n+|\n+$/g, ''))
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} (.*)$/gm, '<strong class="h">$1</strong>');
    frag.append(div);
  });
  return frag;
}

// One-line summary argument per tool, like Claude Code's "Bash(ls -la)".
function toolArg(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === 'string' && v);
  switch (name) {
    case 'Bash': return pick('command');
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep': case 'Glob': return [pick('pattern'), input.path].filter(Boolean).join('  in ');
    case 'WebFetch': return pick('url');
    case 'WebSearch': return pick('query');
    case 'Task': case 'Agent': return pick('description', 'prompt');
    case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
    default: return Object.values(input ?? {}).find((v) => typeof v === 'string') ?? '';
  }
}

const io = (text, cls = '') => el('pre', `io ${cls}`, text);

function toolBlock(b) {
  const d = el('details', 'tool');
  const sum = el('summary');
  const status = el('span', 'tool-status pending', '…');
  sum.append(el('span', 'tool-name', b.name), el('span', 'tool-arg', short(toolArg(b.name, b.input))), status);
  const body = el('div', 'tool-body');
  const input = b.name === 'Bash' && typeof b.input?.command === 'string'
    ? b.input.command + (b.input.description ? `\n# ${b.input.description}` : '')
    : JSON.stringify(b.input, null, 2);
  body.append(el('div', 'io-label', 'Input'), io(input));
  d.append(sum, body);
  tools.set(b.id, { details: d, status, body });
  if (b.result) setToolResult(b.id, b.result);
  return d;
}

function setToolResult(id, r) {
  const t = tools.get(id);
  if (!t) {
    // Result whose tool_use is outside the loaded window.
    const d = el('details', 'tool');
    const sum = el('summary');
    sum.append(el('span', 'tool-name', 'result'), el('span', 'tool-arg', short(r.text)));
    d.append(sum, io(r.text, r.isError ? 'err' : ''));
    append(d, assistantTurn());
    return;
  }
  const n = r.text ? r.text.split('\n').length : 0;
  t.status.className = `tool-status ${r.isError ? 'err' : 'ok'}`;
  t.status.textContent = r.isError ? '✗ error' : `✓ ${n} line${n === 1 ? '' : 's'}`;
  t.body.append(
    el('div', 'io-label', r.isError ? 'Error' : 'Output'),
    io((r.text || '(no output)') + (r.truncated ? '\n… (truncated)' : ''), r.isError ? 'err' : ''),
  );
  if (r.isError) t.details.classList.add('error');
}

function assistantTurn() {
  if (!turn) {
    turn = el('div', 'msg assistant');
    append(turn);
  }
  return turn;
}

function renderBlock(b) {
  const parent = assistantTurn();
  if (b.type === 'text') append(markdown(b.text), parent);
  else if (b.type === 'thinking') {
    const d = el('details', 'thinking');
    d.append(el('summary', null, 'Thinking'), el('div', 'md', b.text));
    append(d, parent);
  } else if (b.type === 'tool_use') append(toolBlock(b), parent);
  else if (b.type === 'tool_result') setToolResult(b.toolUseId, b);
  else if (b.type === 'image') append(el('div', 'note', '[image]'), parent);
}

function userMessage(text) {
  turn = null;
  chat.querySelector('.note.empty')?.remove();
  const m = el('div', 'msg user');
  m.append(markdown(text));
  append(m);
}

function renderMessage(m) {
  if (m.role === 'user') {
    const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) userMessage(text);
    for (const b of m.blocks) if (b.type !== 'text') renderBlock(b);
  } else {
    m.blocks.forEach(renderBlock);
  }
}

// stream-json content -> normalized blocks (same shape as the history API).
function normalize(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const blocks = [];
  for (const b of content ?? []) {
    if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    else if (b.type === 'tool_result') {
      const c = b.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
        : JSON.stringify(c ?? '');
      blocks.push({ type: 'tool_result', toolUseId: b.tool_use_id, text, isError: Boolean(b.is_error) });
    } else if (b.type === 'image') blocks.push({ type: 'image' });
  }
  return blocks;
}

// Every WS message is kept as a collapsed raw entry, visible only in raw mode.
function rawEvent(msg) {
  const ev = msg.type === 'event' ? msg.data : msg;
  const label = msg.type === 'event' ? `event · ${ev?.type ?? '?'}${ev?.subtype ? '/' + ev.subtype : ''}` : msg.type;
  const d = el('details', 'raw');
  d.append(el('summary', null, `raw · ${label}`), io(JSON.stringify(ev, null, 2)));
  append(d, turn ?? chat);
}

// Render one claude stream-json event. Other types only show in raw mode.
function renderEvent(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') note(`● ${ev.model ?? ''} · ${ev.cwd ?? ''}`);
      break;
    case 'assistant':
      normalize(ev.message?.content).forEach(renderBlock);
      break;
    case 'user':
      for (const b of normalize(ev.message?.content)) {
        if (b.type === 'tool_result') setToolResult(b.toolUseId, b);
      }
      break;
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(4)}` : '';
      const dur = ev.duration_ms ? ` · ${(ev.duration_ms / 1000).toFixed(1)}s` : '';
      note(`${ev.is_error ? '✖' : '✔'} ${ev.subtype ?? 'result'}${dur}${cost}`, ev.is_error ? 'err' : 'ok');
      turn = null;
      break;
    }
  }
}

async function loadHistory(s) {
  const token = ++historyToken;
  const loading = el('div', 'note', 'loading history…');
  append(loading);
  try {
    const { messages, truncated } = await api('GET', `/api/sessions/${s.id}/history`);
    if (token !== historyToken) return;
    loading.remove();
    if (truncated) note('(older messages not shown)');
    messages.forEach(renderMessage);
    turn = null;
    if (!messages.length) append(el('div', 'note empty', 'No messages yet.'));
    chat.scrollTop = chat.scrollHeight;
  } catch (err) {
    if (token === historyToken) loading.textContent = `history unavailable: ${err.message}`;
  }
}

// ----------------------------------------------------------------- WS ----
let ws = null;
let wsReady = null;

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return wsReady;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/run`);
  wsReady = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('websocket error'));
  });
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleWsMessage(msg);
  };
  ws.onclose = () => {
    if (state.running) {
      note('connection closed — the run was cancelled', 'err');
      setRunning(false);
    }
    ws = null;
  };
  return wsReady;
}

function handleWsMessage(msg) {
  rawEvent(msg);
  switch (msg.type) {
    case 'started':
      setRunning(true, `running (pid ${msg.pid})`);
      break;
    case 'event':
      renderEvent(msg.data);
      break;
    case 'stderr':
      note(msg.line, 'warn');
      break;
    case 'done':
      if (msg.exitCode !== 0) note(`— exit ${msg.exitCode} —`, 'err');
      turn = null;
      setRunning(false, msg.exitCode === 0 ? 'done' : `exit ${msg.exitCode}`);
      if (state.current) {
        state.current.lastRunAt = new Date().toISOString();
        $('#resume').checked = true;
      }
      loadSessions().catch(() => {});
      break;
    case 'error':
      note(`error: ${msg.message}`, 'err');
      setRunning(false, 'error');
      break;
  }
}

function setRunning(running, label) {
  state.running = running;
  $('#run-btn').disabled = running;
  $('#cancel-btn').disabled = !running;
  const badge = $('#run-status');
  badge.textContent = label ?? (running ? 'running' : 'idle');
  badge.className = 'badge' + (running ? ' live' : '');
}

async function runPrompt() {
  const prompt = $('#prompt').value.trim();
  if (!prompt || state.running) return;
  if (!state.current) {
    note('Select or create a session first (Sessions tab).', 'err');
    return;
  }
  try {
    await connectWs();
  } catch (err) {
    note(`cannot connect: ${err.message}`, 'err');
    return;
  }
  userMessage(prompt);
  setRunning(true, 'starting');
  ws.send(
    JSON.stringify({
      type: 'run',
      sessionId: state.current.id,
      cwd: state.current.cwd,
      prompt,
      resume: $('#resume').checked,
    }),
  );
  $('#prompt').value = '';
}

// ------------------------------------------------------------- views -----
function showLogin() {
  $('#view-main').hidden = true;
  $('#view-login').hidden = false;
  $('#login-form [name=user]').focus();
}

async function showMain() {
  $('#view-login').hidden = true;
  $('#view-main').hidden = false;
  await loadSessions().catch(() => {});
  const next = new URLSearchParams(location.search).get('next');
  if (next && next.startsWith('/apps/')) location.href = next;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of ['sessions', 'console', 'apps']) $(`#tab-${id}`).hidden = id !== name;
  if (name === 'apps') loadApps().catch(() => {});
}

// ---------------------------------------------------------- sessions -----
function fmtDate(s) {
  return s ? new Date(s).toLocaleString() : 'never';
}

async function loadSessions() {
  const { sessions } = await api('GET', '/api/sessions');
  state.sessions = sessions;
  const ul = $('#session-list');
  ul.replaceChildren();
  $('#session-empty').hidden = sessions.length > 0;
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'item' + (state.current?.id === s.id ? ' selected' : '');
    const info = document.createElement('div');
    info.className = 'grow';
    const title = document.createElement('strong');
    title.textContent = s.title;
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = `${s.cwd} · last run ${fmtDate(s.lastRunAt)}`;
    info.append(title, meta);
    const open = document.createElement('button');
    open.className = 'primary small';
    open.textContent = 'Open';
    open.onclick = () => selectSession(s);
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete session "${s.title}"? (Claude's own history is kept on disk.)`)) return;
      await api('DELETE', `/api/sessions/${s.id}`);
      if (state.current?.id === s.id) selectSession(null);
      loadSessions();
    };
    li.append(info, open, del);
    ul.append(li);
  }
}

function selectSession(s) {
  state.current = s;
  $('#console-title').textContent = s ? s.title : 'No session selected';
  $('#console-cwd').textContent = s ? s.cwd : '';
  $('#resume').checked = Boolean(s?.lastRunAt);
  clearChat();
  historyToken += 1;
  if (s) {
    switchTab('console');
    loadHistory(s);
    $('#prompt').focus();
  }
  loadSessions().catch(() => {});
}

// ----------------------------------------------------- dir browser -------
async function browse(dir) {
  const box = $('#dir-browser');
  box.hidden = false;
  const list = $('#dir-list');
  list.replaceChildren();
  try {
    if (!dir) {
      const { roots, missing } = await api('GET', '/api/dirs');
      state.dirPath = null;
      $('#dir-path').textContent = 'allowed roots';
      $('#dir-up').disabled = true;
      $('#dir-pick').disabled = true;
      for (const r of roots) list.append(dirItem(r, r));
      for (const m of missing ?? []) {
        const li = document.createElement('li');
        li.className = 'muted small';
        li.textContent = `${m} (missing)`;
        list.append(li);
      }
      return;
    }
    const data = await api('GET', `/api/dirs?root=${encodeURIComponent(dir)}`);
    state.dirPath = data.path;
    $('#dir-path').textContent = data.path;
    $('#dir-up').disabled = false;
    $('#dir-up').dataset.parent = data.parent ?? '';
    $('#dir-pick').disabled = false;
    if (!data.dirs.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = '(no subdirectories)';
      list.append(li);
    }
    for (const d of data.dirs) list.append(dirItem(d.name + (d.symlink ? ' ↪' : ''), d.path));
  } catch (err) {
    $('#session-error').textContent = err.message;
  }
}

function dirItem(label, p) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = `📁 ${label}`;
  b.onclick = () => browse(p);
  li.append(b);
  return li;
}

// -------------------------------------------------------------- apps -----
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
  const ul = $('#app-list');
  ul.replaceChildren();
  const apps = data.apps ?? [];
  $('#apps-empty').hidden = apps.length > 0;
  for (const a of apps) {
    const li = document.createElement('li');
    li.className = 'item';
    const info = document.createElement('div');
    info.className = 'grow';
    const name = document.createElement('strong');
    name.textContent = a.name;
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = `${a.type} · ${a.status}${a.port ? ` · port ${a.port}` : ''}${a.error ? ` · ${a.error}` : ''}`;
    info.append(name, meta);
    const open = document.createElement('a');
    open.className = 'btn primary small';
    open.href = a.mountPath;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete app "${a.name}" and all its files?`)) return;
      await api('DELETE', `/api/apps/${encodeURIComponent(a.name)}`);
      setTimeout(loadApps, 800);
    };
    li.append(info, open, del);
    ul.append(li);
  }
}

function updateDynamicWarning() {
  const type = $('#new-app [name=type]').value;
  $('#dynamic-warning').hidden = !(type === 'dynamic' && !state.dynamicEnabled);
}

async function pollJob() {
  if (!state.jobId) return;
  let job;
  try {
    job = await api('GET', `/api/apps/jobs/${state.jobId}?since=${state.jobSeen}`);
  } catch {
    return;
  }
  const log = $('#job-log');
  if (job.lines.length) {
    log.textContent += job.lines.join('\n') + '\n';
    log.scrollTop = log.scrollHeight;
  }
  state.jobSeen = job.total;
  $('#job-status').textContent = job.status;
  $('#job-status').className = 'badge' + (job.status === 'running' ? ' live' : '');
  $('#job-cancel').hidden = job.status !== 'running';
  if (job.status === 'running') setTimeout(pollJob, 1500);
  else {
    state.jobId = null;
    loadApps();
  }
}

// ------------------------------------------------------------ wiring -----
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('POST', '/api/login', { user: f.get('user'), pass: f.get('pass') });
    e.target.reset();
    showMain();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  ws?.close();
  showLogin();
});

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('#new-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#session-error').textContent = '';
  try {
    const s = await api('POST', '/api/sessions', { title: f.get('title'), cwd: f.get('cwd') });
    e.target.reset();
    $('#dir-browser').hidden = true;
    selectSession(s);
  } catch (err) {
    $('#session-error').textContent = err.message;
  }
});

$('#browse-btn').addEventListener('click', () => browse(null));
$('#dir-up').addEventListener('click', (e) => browse(e.target.dataset.parent || null));
$('#dir-pick').addEventListener('click', () => {
  if (state.dirPath) $('#cwd-input').value = state.dirPath;
  $('#dir-browser').hidden = true;
});

$('#prompt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runPrompt();
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runPrompt();
  }
});
$('#cancel-btn').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'cancel' }));
  note('cancelling…', 'warn');
});
$('#clear-btn').addEventListener('click', clearChat);
$('#raw-toggle').checked = localStorage.getItem('ccweb.raw') === '1';
chat.classList.toggle('show-raw', $('#raw-toggle').checked);
$('#raw-toggle').addEventListener('change', (e) => {
  chat.classList.toggle('show-raw', e.target.checked);
  localStorage.setItem('ccweb.raw', e.target.checked ? '1' : '0');
});

$('#new-app [name=type]').addEventListener('change', updateDynamicWarning);
$('#new-app').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#app-error').textContent = '';
  try {
    const res = await api('POST', '/api/apps', { name: f.get('name'), type: f.get('type'), prompt: f.get('prompt') });
    state.jobId = res.jobId;
    state.jobSeen = 0;
    $('#job-box').hidden = false;
    $('#job-title').textContent = `Generating ${res.name} (${res.type}) → ${res.url}`;
    $('#job-log').textContent = '';
    pollJob();
  } catch (err) {
    $('#app-error').textContent = err.message;
  }
});
$('#job-cancel').addEventListener('click', () => {
  if (state.jobId) api('POST', `/api/apps/jobs/${state.jobId}/cancel`).catch(() => {});
});
$('#apps-refresh').addEventListener('click', () => loadApps());

// Boot: are we already logged in?
api('GET', '/api/me')
  .then((me) => {
    state.dynamicEnabled = Boolean(me.dynamicAppsEnabled);
    showMain();
  })
  .catch(() => showLogin());
