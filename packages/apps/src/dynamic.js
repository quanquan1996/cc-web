// Dynamic apps: apps/<name>/app.json {type:"dynamic", entry, port} is run as
// `node <entry>` in its own child process and reverse-proxied under
// /apps/<name>/ (prefix stripped). Supervision: periodic HTTP health check,
// auto-restart with exponential backoff, and a circuit breaker that parks a
// crash-looping app for a cooldown period.
//
// Everything here is inert unless APPS_DYNAMIC_ENABLED=true: apps are then
// only registered with status "disabled" and nothing is spawned.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import * as registry from './registry.js';

const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const STARTUP_GRACE_MS = 30_000; // time allowed to become healthy after spawn
const MAX_HEALTH_FAILURES = 3; // consecutive failures before a running app is killed
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_MAX_CRASHES = 5; // crashes inside the window that open the breaker
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;
const LOG_TAIL = 50;

const procs = new Map(); // name -> supervisor state
let log = console;

export const dynamicEnabled = config.dynamicEnabled;
export function setLogger(l) {
  log = l;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const sig = (s) => {
    try {
      // Detached children lead their own process group: kill the whole group.
      if (process.platform !== 'win32') process.kill(-child.pid, s);
      else child.kill(s);
    } catch {
      try {
        child.kill(s);
      } catch {
        /* already gone */
      }
    }
  };
  sig('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) sig('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function clearTimers(st) {
  clearInterval(st.healthTimer);
  clearTimeout(st.restartTimer);
  st.healthTimer = null;
  st.restartTimer = null;
}

function pushLog(st, stream, chunk) {
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    st.logTail.push(`[${stream}] ${line}`);
    if (st.logTail.length > LOG_TAIL) st.logTail.shift();
    log.info({ app: st.name, stream }, line);
  }
}

async function spawnChild(st) {
  if (st.stopping) return;
  const m = st.manifest;
  const fixed = Number.isInteger(m.port) && m.port >= 1024 && m.port <= 65535 ? m.port : 0;
  st.port = fixed || (await freePort());

  // Minimal environment: the app never sees the console's secrets.
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    HOME: st.dir,
    PORT: String(st.port),
    HOST: '127.0.0.1',
    APP_NAME: st.name,
    BASE_PATH: `/apps/${st.name}/`,
  };
  const child = spawn(process.execPath, [st.entryPath], {
    cwd: st.dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  st.child = child;
  st.startedAt = Date.now();
  st.healthFailures = 0;
  registry.update(st.name, {
    status: st.restarts ? 'restarting' : 'starting',
    pid: child.pid ?? null,
    port: st.port,
    error: null,
  });
  log.info({ app: st.name, pid: child.pid, port: st.port }, 'dynamic app spawned');

  child.stdout.on('data', (c) => pushLog(st, 'out', c));
  child.stderr.on('data', (c) => pushLog(st, 'err', c));
  child.on('error', (err) => {
    st.lastError = err.message;
  });
  child.on('exit', (code, signal) => onExit(st, child, code, signal));

  clearInterval(st.healthTimer);
  st.healthTimer = setInterval(() => healthTick(st), HEALTH_INTERVAL_MS);
  st.healthTimer.unref();
  setTimeout(() => healthTick(st), 500).unref();
}

async function healthTick(st) {
  const child = st.child;
  if (!child || st.stopping || st.probing) return;
  st.probing = true;
  const ok = await probe(st.port);
  st.probing = false;
  if (st.child !== child) return;
  const entry = registry.get(st.name);
  if (ok) {
    st.healthFailures = 0;
    if (entry && entry.status !== 'running') {
      st.backoffStep = 0;
      registry.update(st.name, { status: 'running', error: null });
      log.info({ app: st.name, port: st.port }, 'dynamic app healthy');
    }
    return;
  }
  st.healthFailures += 1;
  const running = entry?.status === 'running';
  const timedOut = !running && Date.now() - st.startedAt > STARTUP_GRACE_MS;
  if (timedOut || (running && st.healthFailures >= MAX_HEALTH_FAILURES)) {
    log.warn({ app: st.name, failures: st.healthFailures }, 'health check failed, killing app');
    st.lastError = timedOut ? 'did not become healthy in time' : 'health check failed';
    killChild(child);
  }
}

function onExit(st, child, code, signal) {
  if (st.child !== child) return; // a stale child from a previous generation
  st.child = null;
  clearInterval(st.healthTimer);
  if (st.stopping) return;

  const now = Date.now();
  st.crashes = st.crashes.filter((t) => now - t < BREAKER_WINDOW_MS);
  st.crashes.push(now);
  st.restarts += 1;
  const last = st.logTail.filter((l) => l.startsWith('[err]')).slice(-1)[0] ?? '';
  const error = `${st.lastError ? st.lastError + '; ' : ''}exited (code ${code}, signal ${signal})${last ? ': ' + last.slice(6, 300) : ''}`;
  st.lastError = null;
  log.warn({ app: st.name, code, signal }, 'dynamic app exited');

  if (st.crashes.length >= BREAKER_MAX_CRASHES) {
    // Circuit open: stop hammering; one retry after the cooldown (half-open).
    registry.update(st.name, {
      status: 'failed',
      pid: null,
      restarts: st.restarts,
      error: `circuit open after ${st.crashes.length} crashes in ${BREAKER_WINDOW_MS / 1000}s, retry in ${BREAKER_COOLDOWN_MS / 60000} min. ${error}`,
    });
    st.restartTimer = setTimeout(() => {
      st.crashes = [];
      st.backoffStep = 0;
      spawnChild(st).catch((err) => registry.update(st.name, { status: 'failed', error: err.message }));
    }, BREAKER_COOLDOWN_MS);
    st.restartTimer.unref();
    return;
  }

  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** st.backoffStep);
  st.backoffStep += 1;
  registry.update(st.name, { status: 'restarting', pid: null, restarts: st.restarts, error });
  st.restartTimer = setTimeout(() => {
    spawnChild(st).catch((err) => registry.update(st.name, { status: 'failed', error: err.message }));
  }, delay);
  st.restartTimer.unref();
}

/** (Re)start a dynamic app from its manifest. Resets backoff and breaker. */
export async function startDynamic(name, dir, manifest) {
  await stopDynamic(name, { keepEntry: true });

  if (!config.dynamicEnabled) {
    registry.add(name, { type: 'dynamic', status: 'disabled', dir, error: 'APPS_DYNAMIC_ENABLED is false' });
    return;
  }
  const entryPath = path.resolve(dir, manifest.entry || 'server.js');
  if (!isWithin(dir, entryPath)) {
    registry.add(name, { type: 'dynamic', status: 'invalid', dir, error: 'entry must be inside the app directory' });
    return;
  }
  try {
    await fs.access(entryPath);
  } catch {
    // Probably still being generated; the watcher re-runs us when it appears.
    registry.add(name, { type: 'dynamic', status: 'pending', dir, error: `entry ${manifest.entry || 'server.js'} not found` });
    return;
  }

  const st = {
    name,
    dir,
    manifest,
    entryPath,
    child: null,
    port: null,
    restarts: 0,
    backoffStep: 0,
    crashes: [],
    healthFailures: 0,
    healthTimer: null,
    restartTimer: null,
    stopping: false,
    probing: false,
    startedAt: 0,
    lastError: null,
    logTail: [],
  };
  procs.set(name, st);
  registry.add(name, { type: 'dynamic', status: 'starting', dir, restarts: 0 });
  await spawnChild(st);
}

/** Stop the child (if any). Unless keepEntry, also drop it from the registry. */
export async function stopDynamic(name, { keepEntry = false } = {}) {
  const st = procs.get(name);
  if (st) {
    st.stopping = true;
    clearTimers(st);
    const child = st.child;
    st.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, KILL_GRACE_MS + 1000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        killChild(child);
      });
    }
    procs.delete(name);
  }
  if (!keepEntry) registry.remove(name);
}

export async function stopAll() {
  await Promise.all([...procs.keys()].map((n) => stopDynamic(n)));
}

export function logsFor(name) {
  return procs.get(name)?.logTail ?? [];
}

function notRunningHtml(entry) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(entry.name)} unavailable</title>
<body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:2rem">
<h1>${esc(entry.name)} is ${esc(entry.status)}</h1><p>${esc(entry.error)}</p>
<p>Retrying automatically. Reload in a few seconds.</p></body>`;
}

/** Path + query after /apps/<name>, taken from the raw URL (no re-encoding). */
function upstreamPath(rawUrl) {
  const i = rawUrl.indexOf('/', '/apps/'.length);
  return i === -1 ? '/' : rawUrl.slice(i);
}

/** Reverse-proxy an HTTP request to a running dynamic app. */
export function proxyHttp(req, reply, entry) {
  const st = procs.get(entry.name);
  if (!st || !st.child || entry.status !== 'running') {
    return reply.code(503).header('Retry-After', '3').type('text/html; charset=utf-8').send(notRunningHtml(entry));
  }
  reply.hijack();
  const raw = req.raw;
  const res = reply.raw;
  const headers = {
    ...raw.headers,
    host: `127.0.0.1:${st.port}`,
    'x-forwarded-host': raw.headers.host,
    'x-forwarded-prefix': `/apps/${entry.name}`,
  };
  const up = http.request(
    { host: '127.0.0.1', port: st.port, method: raw.method, path: upstreamPath(raw.url), headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad gateway');
  });
  res.on('close', () => up.destroy());
  const body = req.body;
  if (body && typeof body.pipe === 'function') body.pipe(up);
  else if (body !== undefined && body !== null) up.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  else up.end();
}

/** Tunnel a WebSocket upgrade for /apps/<name>/... to a running dynamic app. */
export function proxyUpgrade(req, socket, head) {
  const reject = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const m = /^\/apps\/([^/?]+)\//.exec(req.url || '');
  let entry = null;
  try {
    entry = m ? registry.get(decodeURIComponent(m[1])) : null;
  } catch {
    /* malformed escape */
  }
  const st = entry ? procs.get(entry.name) : null;
  if (!entry || entry.type !== 'dynamic' || entry.status !== 'running' || !st?.child) {
    return reject(503, 'Service Unavailable');
  }
  const up = net.connect(st.port, '127.0.0.1');
  let connected = false;
  up.on('connect', () => {
    connected = true;
    const lines = [`${req.method} ${upstreamPath(req.url)} HTTP/1.1`, `Host: 127.0.0.1:${st.port}`];
    const rh = req.rawHeaders;
    for (let i = 0; i < rh.length; i += 2) {
      if (rh[i].toLowerCase() === 'host') continue;
      lines.push(`${rh[i]}: ${rh[i + 1]}`);
    }
    lines.push(`X-Forwarded-Prefix: /apps/${entry.name}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => {
    if (!connected) reject(502, 'Bad Gateway');
    else socket.destroy();
  });
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}
