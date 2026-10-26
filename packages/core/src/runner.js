// Spawns `claude -p` in stream-json mode and turns its stdout into events.
//
//   const r = await run(prompt, { cwd, sessionId, resume });
//   r.on('event', obj) / r.on('stdout', line) / r.on('stderr', line)
//   r.on('exit', { exitCode, signal, sessionId }) / r.on('error', err)
//   r.cancel()   // SIGTERM, then SIGKILL after a grace period
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { resolveSafe } from './dirs.js';

const KILL_GRACE_MS = 5000;
// Secrets of the console itself are never handed to Claude.
const SCRUBBED_ENV = ['JWT_SECRET', 'ORIGIN_SECRET', 'ADMIN_PASS_HASH', 'ADMIN_USER'];

let active = 0;
let externalActive = () => 0;
/** Lets jobs.js count its detached runs against the same MAX_CONCURRENT_RUNS. */
export function countExternalRuns(fn) {
  externalActive = fn;
}
export const activeRuns = () => active + externalActive();

export class RunnerError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function splitLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf) onLine(buf);
    buf = '';
  });
}

class Run extends EventEmitter {
  constructor(child, sessionId) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.sessionId = sessionId;
    this.observedSessionId = null;
    this.exited = false;
    this._killTimer = null;
  }

  cancel() {
    if (this.exited) return;
    this.child.kill('SIGTERM');
    this._killTimer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    this._killTimer.unref();
  }
}

export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new RunnerError('prompt is required');
  if (prompt.length > 100_000) throw new RunnerError('prompt too long');
}

export function assertCapacity() {
  if (activeRuns() >= config.maxConcurrentRuns) {
    throw new RunnerError(`too many concurrent runs (max ${config.maxConcurrentRuns})`, 429);
  }
}

export function claudeArgs(prompt, { sessionId, resume = false, extraArgs = [] }) {
  // A leading "-" would be parsed as a CLI flag.
  const promptArg = prompt.startsWith('-') ? ` ${prompt}` : prompt;
  return [
    '-p', promptArg,
    '--output-format', 'stream-json',
    '--verbose',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...config.claudeExtraArgs,
    ...extraArgs,
  ];
}

export function claudeEnv() {
  const env = { ...process.env };
  for (const k of SCRUBBED_ENV) delete env[k];
  return env;
}

/**
 * @param {string} prompt
 * @param {{cwd: string, sessionId: string, resume?: boolean, roots?: string[], extraArgs?: string[]}} opts
 */
export async function run(prompt, { cwd, sessionId, resume = false, roots, extraArgs = [] }) {
  validatePrompt(prompt);
  if (!sessionId) throw new RunnerError('sessionId is required');
  assertCapacity();
  const safeCwd = await resolveSafe(cwd, roots);
  const args = claudeArgs(prompt, { sessionId, resume, extraArgs });
  const env = claudeEnv();

  const child = spawn(config.claudeBin, args, {
    cwd: safeCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const r = new Run(child, sessionId);
  active += 1;

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      active -= 1;
    }
  };

  splitLines(child.stdout, (line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      r.emit('stdout', line);
      return;
    }
    if (obj && typeof obj.session_id === 'string') r.observedSessionId = obj.session_id;
    r.emit('event', obj);
  });
  splitLines(child.stderr, (line) => r.emit('stderr', line));

  child.on('error', (err) => {
    // e.g. ENOENT when CLAUDE_BIN is not installed; 'close' may not follow.
    r.exited = true;
    release();
    r.emit('error', err);
  });
  child.on('close', (code, signal) => {
    r.exited = true;
    clearTimeout(r._killTimer);
    release();
    r.emit('exit', {
      exitCode: code ?? (signal ? 128 : -1),
      signal,
      sessionId: r.observedSessionId ?? sessionId,
    });
  });

  return r;
}
