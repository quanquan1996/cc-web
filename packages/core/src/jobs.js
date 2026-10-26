// Detached `claude -p` jobs that outlive the browser connection and core itself.
//
// A job is started over HTTP and runs to completion whatever happens to the
// client: claude is spawned detached (own process group) with stdout/stderr
// redirected straight into files, so neither a closed socket nor a core
// restart touches it. Files in DATA_DIR/jobs/:
//   <id>.json  metadata (status, pid, prompt, timestamps …), rewritten atomically
//   <id>.out   claude's stream-json stdout, one event per line (written by claude)
//   <id>.err   claude's stderr
//
// Clients read <id>.out incrementally with a byte-offset cursor, by HTTP
// long-poll (GET /api/jobs/:id/events) or pushed over WS /ws/run; both use
// collect(). The cursor always sits on a line boundary and every batch carries
// the cursor it started from, so a client applying only batches whose `from`
// equals its own cursor never sees an event twice or misses one.
//
//   POST /api/sessions/:id/jobs   {prompt, clientRequestId?} -> 201 {job} | 200 {job, existing} | 409 {error, job}
//   GET  /api/sessions/:id/jobs   -> {jobs}  (newest first)
//   GET  /api/jobs?status=running -> {jobs}
//   GET  /api/jobs/:id            -> {job}
//   GET  /api/jobs/:id/events?cursor=0&wait=25 -> {job, from, cursor, events, more}
//   POST /api/jobs/:id/cancel     -> {job}
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { config } from './config.js';
import { verifyAuth, clientIp } from './auth.js';
import { getSession, updateSession, onSessionDelete } from './sessions.js';
import { resolveSafe } from './dirs.js';
import { findTranscript, toBlocks } from './history.js';
import { claudeArgs, claudeEnv, validatePrompt, assertCapacity, countExternalRuns, RunnerError } from './runner.js';
import { audit } from './audit.js';

const DIR = path.join(config.dataDir, 'jobs');
// claude keeps tool output under $TMPDIR/claude-<uid>/. A unit-private /tmp is
// wiped when core restarts, which would break jobs that outlive it.
const TMP = path.join(config.dataDir, 'tmp');
const WATCH_MS = 250; // stat() interval for output files of running jobs
const ORPHAN_CHECK_EVERY = 4; // liveness check of adopted processes every N ticks
const KILL_GRACE_MS = 5000;
export const MAX_WAIT_MS = 25_000; // long-poll cap, well under CloudFront's 60 s origin timeout
const BATCH_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

fs.mkdirSync(DIR, { recursive: true, mode: 0o750 });
fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });

const jobs = new Map(); // id -> metadata
const live = new Map(); // id -> { emitter, timer, size, child }
const starting = new Set(); // session ids with a start in flight
let closing = false;

/** Called on shutdown: answer pending long-polls now instead of holding up
 *  the restart. The jobs themselves keep running. */
export function releaseWaiters() {
  closing = true;
  for (const entry of live.values()) entry.emitter.emit('change');
}

const metaPath = (id) => path.join(DIR, `${id}.json`);
const outPath = (id) => path.join(DIR, `${id}.out`);
const errPath = (id) => path.join(DIR, `${id}.err`);

function saveMeta(job) {
  const tmp = `${metaPath(job.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, metaPath(job.id));
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, max) {
  const size = fileSize(file);
  return size ? readRange(file, Math.max(0, size - max), Math.min(size, max)).toString('utf8') : '';
}

export const runningJobs = () => [...jobs.values()].filter((j) => j.status === 'running');
countExternalRuns(() => runningJobs().length);

export const getJob = (id) => jobs.get(id) ?? null;

export function sessionJobs(sessionId) {
  return [...jobs.values()].filter((j) => j.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ------------------------------------------------------------ processes ----

/** True if `job.pid` is still our claude process (guards against pid reuse
 *  after a core restart: the cmdline must contain the Claude session id). */
function processAlive(job) {
  if (!job.pid) return false;
  try {
    process.kill(job.pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  try {
    return fs.readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').includes(job.claudeSessionId);
  } catch {
    return process.platform !== 'linux'; // no /proc: trust kill(0)
  }
}

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig); // detached => claude leads its own process group
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/** Starts watching a running job's output file. `child` is set when this core
 *  process spawned it; adopted jobs (from before a restart) are polled. */
function watch(job, child = null) {
  const entry = { emitter: new EventEmitter(), size: fileSize(outPath(job.id)), child, timer: null };
  entry.emitter.setMaxListeners(0);
  let ticks = 0;
  entry.timer = setInterval(() => {
    const size = fileSize(outPath(job.id));
    if (size !== entry.size) {
      entry.size = size;
      entry.emitter.emit('change');
    }
    if (!entry.child && ++ticks % ORPHAN_CHECK_EVERY === 0 && !processAlive(job)) finalize(job, {});
  }, WATCH_MS);
  live.set(job.id, entry);
}

/** Decides the final status from the exit code and the last `result` event. */
function finalize(job, { exitCode = null, signal = null, error = null }) {
  if (job.status !== 'running') return;
  const entry = live.get(job.id);
  if (entry) clearInterval(entry.timer);

  let result = null;
  for (const line of readTail(outPath(job.id), TAIL_BYTES).split('\n').reverse()) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'result') {
        result = obj;
        break;
      }
    } catch {
      /* cut line at the start of the tail */
    }
  }
  job.exitCode = exitCode;
  job.signal = signal;
  job.endedAt = new Date().toISOString();
  job.outBytes = fileSize(outPath(job.id));
  job.result = result
    ? { subtype: result.subtype ?? null, isError: Boolean(result.is_error), durationMs: result.duration_ms ?? null, costUsd: result.total_cost_usd ?? null }
    : null;
  if (job.cancelRequested) job.status = 'cancelled';
  else if (!error && result && !result.is_error && (exitCode === null || exitCode === 0)) job.status = 'done';
  else {
    job.status = 'failed';
    job.error =
      error ||
      (result?.is_error ? `claude reported ${result.subtype ?? 'an error'}` : null) ||
      (exitCode !== null ? `claude exited with code ${exitCode}${signal ? ` (${signal})` : ''}` : 'claude exited without a result');
  }
  if (job.status !== 'done') job.stderr = readTail(errPath(job.id), 4096).trim() || null;
  saveMeta(job);
  audit('job_end', { id: job.id, sessionId: job.sessionId, status: job.status, exitCode });

  // Claude may report a different session id than the one we passed; keep it for --resume.
  const sid = result?.session_id;
  if (sid && sid !== job.claudeSessionId) {
    getSession(job.sessionId)
      .then((s) => s && updateSession(s.id, { claudeSessionId: sid }))
      .catch(() => {});
  }
  live.delete(job.id);
  entry?.emitter.emit('change');
}

export async function startJob(session, { prompt, clientRequestId = null, ip = null }) {
  validatePrompt(prompt);
  if (clientRequestId !== null && (typeof clientRequestId !== 'string' || clientRequestId.length > 100)) {
    throw new RunnerError('bad clientRequestId');
  }
  // A retried POST (response lost on a flaky network) gets the original job back.
  if (clientRequestId) {
    const dup = sessionJobs(session.id).find((j) => j.clientRequestId === clientRequestId);
    if (dup) return { job: dup, existing: true };
  }
  const busy = sessionJobs(session.id).find((j) => j.status === 'running');
  if (busy || starting.has(session.id)) {
    const err = new RunnerError('this session already has a running task', 409);
    err.job = busy ?? null;
    throw err;
  }
  assertCapacity();
  starting.add(session.id);
  try {
    const cwd = await resolveSafe(session.cwd);
    const claudeSessionId = session.claudeSessionId || session.id;
    // First run creates the Claude session (--session-id), later runs --resume it.
    const resume = Boolean(await findTranscript(claudeSessionId, cwd));
    const id = uuidv4();
    const now = new Date().toISOString();
    const job = {
      id,
      sessionId: session.id,
      clientRequestId,
      prompt,
      cwd,
      claudeSessionId,
      resume,
      status: 'running',
      pid: null,
      createdAt: now,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      cancelRequested: false,
    };

    const outFd = fs.openSync(outPath(id), 'a', 0o640);
    const errFd = fs.openSync(errPath(id), 'a', 0o640);
    let child;
    try {
      child = spawn(
        config.claudeBin,
        claudeArgs(prompt, { sessionId: claudeSessionId, resume, extraArgs: ['--include-partial-messages'] }),
        { cwd, env: { ...claudeEnv(), TMPDIR: TMP }, stdio: ['ignore', outFd, errFd], detached: true, windowsHide: true },
      );
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    job.pid = child.pid ?? null;
    jobs.set(id, job);
    saveMeta(job);
    watch(job, child);
    // e.g. ENOENT when CLAUDE_BIN is missing; 'exit' may not follow.
    child.on('error', (err) => finalize(job, { error: `failed to start claude: ${err.message}` }));
    child.on('exit', (code, signal) => finalize(job, { exitCode: code, signal }));

    audit('job_start', { ip, id, sessionId: session.id, cwd, resume, pid: job.pid, prompt: prompt.slice(0, 2000) });
    updateSession(session.id, { lastRunAt: now }).catch(() => {});
    return { job, existing: false };
  } finally {
    starting.delete(session.id);
  }
}

export function cancelJob(job) {
  if (job.status !== 'running') return;
  job.cancelRequested = true;
  saveMeta(job);
  if (!processAlive(job)) return finalize(job, {});
  killGroup(job.pid, 'SIGTERM');
  setTimeout(() => {
    if (job.status === 'running' && processAlive(job)) killGroup(job.pid, 'SIGKILL');
  }, KILL_GRACE_MS).unref();
}

// --------------------------------------------------------------- events ----

/** stream-json event -> compact view event for the browser (null = not shown).
 *  Blocks use the same shape as the history API. */
function viewEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.parent_tool_use_id) return null; // sub-agent internals, hidden like sidechains in history
  switch (obj.type) {
    case 'stream_event': {
      const e = obj.event;
      if (e?.type !== 'content_block_delta') return null;
      if (!(e.delta?.text || e.delta?.thinking)) return null;
      if (e.delta?.type === 'text_delta') return { t: 'delta', kind: 'text', i: e.index, text: e.delta.text };
      if (e.delta?.type === 'thinking_delta') return { t: 'delta', kind: 'thinking', i: e.index, text: e.delta.thinking };
      return null;
    }
    case 'system':
      return obj.subtype === 'init' ? { t: 'init', model: obj.model ?? null, cwd: obj.cwd ?? null } : null;
    case 'assistant': {
      const blocks = toBlocks(obj.message?.content);
      return blocks.length ? { t: 'assistant', id: obj.message?.id ?? null, blocks } : null;
    }
    case 'user': {
      const blocks = toBlocks(obj.message?.content).filter((b) => b.type === 'tool_result');
      return blocks.length ? { t: 'user', blocks } : null;
    }
    case 'result':
      return {
        t: 'result',
        subtype: obj.subtype ?? null,
        isError: Boolean(obj.is_error),
        durationMs: obj.duration_ms ?? null,
        costUsd: obj.total_cost_usd ?? null,
      };
    default:
      return null;
  }
}

/** Deltas are only useful while their block is still being written: drop the
 *  ones superseded by a complete event in the same batch (so catching up after
 *  being offline costs no more than the final messages) and merge the rest. */
function compact(events) {
  let lastFull = -1;
  events.forEach((e, i) => {
    if (e.t !== 'delta') lastFull = i;
  });
  const out = [];
  events.forEach((e, i) => {
    if (e.t === 'delta' && i < lastFull) return;
    const prev = out[out.length - 1];
    if (e.t === 'delta' && prev?.t === 'delta' && prev.kind === e.kind && prev.i === e.i) prev.text += e.text;
    else out.push(e);
  });
  return out;
}

/** Complete lines of <id>.out from `cursor`, as view events. */
function readEvents(job, cursor) {
  const file = outPath(job.id);
  const size = fileSize(file);
  if (cursor >= size) return { events: [], cursor: Math.min(cursor, size), more: false };
  const finished = job.status !== 'running';
  let len = Math.min(size - cursor, BATCH_BYTES);
  let buf = readRange(file, cursor, len);
  let nl = buf.lastIndexOf(10);
  // One line (e.g. a huge tool result) may be bigger than a batch.
  while (nl === -1 && cursor + len < size) {
    len = Math.min(size - cursor, len * 2);
    buf = readRange(file, cursor, len);
    nl = buf.lastIndexOf(10);
  }
  let end;
  if (nl !== -1) end = cursor + nl + 1;
  else if (finished) end = cursor + buf.length; // trailing line without newline
  else return { events: [], cursor, more: false }; // line still being written

  const events = [];
  for (const line of buf.subarray(0, end - cursor).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      events.push({ t: 'raw', text: line.slice(0, 2000) });
      continue;
    }
    const v = viewEvent(obj);
    if (v) events.push(v);
  }
  return { events: compact(events), cursor: end, more: end < size };
}

function waitForChange(job, ms, signal) {
  const entry = live.get(job.id);
  if (!entry || ms <= 0 || signal?.aborted || closing) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      entry.emitter.off('change', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    entry.emitter.once('change', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Events after `cursor`, waiting up to `waitMs` for new output while the job runs. */
export async function collect(job, cursor, waitMs = 0, signal = null) {
  const from = cursor;
  const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
  const events = [];
  let more = false;
  for (;;) {
    const r = readEvents(job, cursor);
    events.push(...r.events);
    cursor = r.cursor;
    more = r.more;
    if (events.length || signal?.aborted) break;
    if (more) continue; // the batch was all superseded deltas; keep reading
    if (job.status !== 'running' || Date.now() >= deadline || closing) break;
    await waitForChange(job, deadline - Date.now(), signal);
  }
  if (!more) more = cursor < fileSize(outPath(job.id));
  return { job: publicJob(job), from, cursor, events, more };
}

export function publicJob(job) {
  const { clientRequestId, cwd, claudeSessionId, ...pub } = job;
  return { ...pub, clientRequestId };
}

// ------------------------------------------------------- startup/cleanup ----

function loadJobs() {
  const cutoff = Date.now() - config.jobsRetentionDays * 86_400_000;
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
    } catch {
      continue;
    }
    if (!uuidValidate(job?.id)) continue;
    if (job.status !== 'running' && Date.parse(job.endedAt ?? job.createdAt) < cutoff) {
      for (const f of [metaPath(job.id), outPath(job.id), errPath(job.id)]) fs.rmSync(f, { force: true });
      continue;
    }
    jobs.set(job.id, job);
    // Still running from before a core restart: adopt it, or settle it if it died meanwhile.
    if (job.status === 'running') {
      if (processAlive(job)) watch(job);
      else finalize(job, {});
    }
  }
}
loadJobs();

onSessionDelete((id) => {
  for (const j of sessionJobs(id)) if (j.status === 'running') cancelJob(j);
});

// ----------------------------------------------------------------- HTTP ----

export function registerJobs(app) {
  const jobParam = (req, reply) => {
    const job = uuidValidate(req.params.id) ? getJob(req.params.id) : null;
    if (!job) reply.code(404).send({ error: 'not found' });
    return job;
  };

  app.post('/api/sessions/:id/jobs', { preHandler: verifyAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!uuidValidate(id)) return reply.code(400).send({ error: 'bad id' });
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: 'unknown session' });
    const { prompt, clientRequestId } = req.body ?? {};
    try {
      const { job, existing } = await startJob(session, { prompt, clientRequestId: clientRequestId ?? null, ip: clientIp(req) });
      if (!existing) req.log.info({ jobId: job.id, sessionId: id, pid: job.pid }, 'job started');
      return reply.code(existing ? 200 : 201).send({ job: publicJob(job), existing });
    } catch (err) {
      return reply
        .code(err.statusCode ?? 500)
        .send({ error: err.message, ...(err.job ? { job: publicJob(err.job) } : {}) });
    }
  });

  app.get('/api/sessions/:id/jobs', { preHandler: verifyAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!uuidValidate(id)) return reply.code(400).send({ error: 'bad id' });
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 20, 1), 200);
    return { jobs: sessionJobs(id).slice(0, limit).map(publicJob) };
  });

  app.get('/api/jobs', { preHandler: verifyAuth }, async (req) => {
    const list = req.query?.status === 'running' ? runningJobs() : [...jobs.values()];
    return { jobs: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map(publicJob) };
  });

  app.get('/api/jobs/:id', { preHandler: verifyAuth }, async (req, reply) => {
    const job = jobParam(req, reply);
    return job ? { job: publicJob(job) } : reply;
  });

  app.get('/api/jobs/:id/events', { preHandler: verifyAuth }, async (req, reply) => {
    const job = jobParam(req, reply);
    if (!job) return reply;
    const cursor = Math.max(0, Number.parseInt(req.query?.cursor, 10) || 0);
    const waitMs = Math.max(0, Number(req.query?.wait) || 0) * 1000;
    // Stop waiting as soon as the client goes away.
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    return collect(job, cursor, waitMs, ac.signal);
  });

  app.post('/api/jobs/:id/cancel', { preHandler: verifyAuth }, async (req, reply) => {
    const job = jobParam(req, reply);
    if (!job) return reply;
    if (job.status === 'running') {
      audit('job_cancel', { ip: clientIp(req), id: job.id, pid: job.pid });
      cancelJob(job);
    }
    return { job: publicJob(job) };
  });
}
