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

// ----------------------------------------------------------- terminal ----
const ANSI = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };

const out = (() => {
  const el = $('#terminal');
  const TerminalCtor = window.Terminal?.Terminal ?? window.Terminal;
  if (typeof TerminalCtor === 'function') {
    const term = new TerminalCtor({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontSize: window.innerWidth < 600 ? 12 : 13,
      scrollback: 10000,
      theme: { background: '#0b0d12' },
    });
    let fit = null;
    if (window.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(el);
    const refit = () => {
      try {
        fit?.fit();
      } catch {
        /* hidden */
      }
    };
    window.addEventListener('resize', refit);
    return { write: (s) => term.write(s), clear: () => term.clear(), refit };
  }
  // Fallback when the CDN is unreachable: plain <pre>.
  const pre = document.createElement('pre');
  pre.className = 'fallback-term';
  el.appendChild(pre);
  return {
    write: (s) => {
      pre.textContent += s.replace(/\x1b\[[0-9;]*m/g, '');
      pre.scrollTop = pre.scrollHeight;
    },
    clear: () => {
      pre.textContent = '';
    },
    refit: () => {},
  };
})();

const line = (s = '', color) => out.write((color ? ANSI[color] + s + ANSI.reset : s) + '\r\n');

function short(v, n = 160) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

// Render one claude stream-json event.
function renderEvent(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') line(`● session ${ev.session_id} · ${ev.model ?? ''} · ${ev.cwd ?? ''}`, 'dim');
      else line(`[system] ${short(ev)}`, 'dim');
      break;
    case 'assistant':
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text') line(b.text);
        else if (b.type === 'thinking') line(short(b.thinking, 400), 'dim');
        else if (b.type === 'tool_use') line(`⚙ ${b.name} ${short(b.input)}`, 'cyan');
      }
      break;
    case 'user':
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const lines = toolResultText(b.content).split('\n');
        const shown = lines.slice(0, 15).join('\n');
        line(shown + (lines.length > 15 ? `\n… (${lines.length - 15} more lines)` : ''), b.is_error ? 'red' : 'dim');
      }
      break;
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(4)}` : '';
      const dur = ev.duration_ms ? ` · ${(ev.duration_ms / 1000).toFixed(1)}s` : '';
      line(`${ev.is_error ? '✖' : '✔'} ${ev.subtype ?? 'result'}${dur}${cost}`, ev.is_error ? 'red' : 'green');
      break;
    }
    default:
      line(short(ev, 300), 'dim');
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
      line('connection closed — the run was cancelled', 'red');
      setRunning(false);
    }
    ws = null;
  };
  return wsReady;
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'started':
      setRunning(true, `running (pid ${msg.pid})`);
      break;
    case 'event':
      renderEvent(msg.data);
      break;
    case 'stderr':
      line(msg.line, 'yellow');
      break;
    case 'done':
      line(`— exit ${msg.exitCode} —`, msg.exitCode === 0 ? 'dim' : 'red');
      setRunning(false, msg.exitCode === 0 ? 'done' : `exit ${msg.exitCode}`);
      if (state.current) {
        state.current.lastRunAt = new Date().toISOString();
        $('#resume').checked = true;
      }
      loadSessions().catch(() => {});
      break;
    case 'error':
      line(`error: ${msg.message}`, 'red');
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
    line('Select or create a session first (Sessions tab).', 'red');
    return;
  }
  try {
    await connectWs();
  } catch (err) {
    line(`cannot connect: ${err.message}`, 'red');
    return;
  }
  line(`❯ ${prompt}`, 'bold');
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
  if (name === 'console') setTimeout(out.refit, 0);
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
  out.clear();
  if (s) {
    line(`Session ${s.id}`, 'dim');
    line(`cwd ${s.cwd}`, 'dim');
    switchTab('console');
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
  line('cancelling…', 'yellow');
});
$('#clear-btn').addEventListener('click', () => out.clear());

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
