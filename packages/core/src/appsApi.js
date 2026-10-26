// /api/apps — list apps (from the apps service registry) and create apps by
// running `claude -p` with cwd = APPS_DIR/<name>/. The apps service picks the
// result up via its file watcher; core never executes app code itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { verifyAuth, clientIp } from './auth.js';
import { run } from './runner.js';
import { isWithin } from './dirs.js';
import { audit } from './audit.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_LOG_LINES = 1000;
const jobs = new Map(); // id -> job

function staticPrompt(name, userPrompt) {
  return [
    `You are creating a STATIC web app named "${name}" in the current directory.`,
    `It will be served at the URL path /apps/${name}/ inside a sandboxed page (no cookies, no localStorage guarantees, no access to /api).`,
    'Requirements:',
    '- Write index.html plus any CSS/JS/asset files in this directory only. Never touch files outside it.',
    '- Use only RELATIVE URLs (e.g. "style.css", "./app.js"), never absolute paths starting with "/".',
    '- No build step, no npm packages; plain HTML/CSS/JS (CDN links are fine).',
    `- Keep the existing app.json ({"name":"${name}","type":"static"}).`,
    '- Make it mobile friendly.',
    '',
    'App description:',
    userPrompt,
  ].join('\n');
}

function dynamicPrompt(name, userPrompt) {
  return [
    `You are creating a DYNAMIC Node.js web app named "${name}" in the current directory.`,
    `It is reverse-proxied from /apps/${name}/ with that prefix STRIPPED, so the server sees paths starting at "/".`,
    'Requirements:',
    '- Write server.js: a dependency-free Node.js (>=20) HTTP server using only built-in modules, in CommonJS (require).',
    '- It MUST listen on Number(process.env.PORT) and host process.env.HOST || "127.0.0.1".',
    '- It MUST answer GET / with a 2xx/3xx status (used as the health check).',
    '- Use only RELATIVE URLs in any HTML it serves (e.g. "api/items", not "/api/items").',
    '- Persist data, if needed, as JSON files inside this directory only. Never touch files outside it.',
    `- Write app.json LAST, exactly: {"name":"${name}","type":"dynamic","entry":"server.js","port":0}`,
    '',
    'App description:',
    userPrompt,
  ].join('\n');
}

function summarize(ev) {
  if (!ev || typeof ev !== 'object') return [];
  if (ev.type === 'system' && ev.subtype === 'init') return [`[init] session ${ev.session_id ?? ''}`];
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    return ev.message.content.flatMap((b) => {
      if (b.type === 'text' && b.text) return b.text.split('\n');
      if (b.type === 'tool_use') return [`> ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 200)}`];
      return [];
    });
  }
  if (ev.type === 'result') {
    return [`[result] ${ev.subtype ?? ''}${ev.is_error ? ' (error)' : ''} ${ev.duration_ms ?? ''}ms`];
  }
  return [];
}

async function fetchRegistry() {
  const res = await fetch(`${config.appsServiceUrl}/api/apps`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`apps service returned ${res.status}`);
  return res.json();
}

export function registerAppsApi(app) {
  app.get('/api/apps', { preHandler: verifyAuth }, async (req, reply) => {
    const jobList = [...jobs.values()].map(({ log, run: _r, ...j }) => j);
    try {
      const data = await fetchRegistry();
      return { ...data, jobs: jobList, available: true };
    } catch (err) {
      req.log.warn({ err: err.message }, 'apps service unreachable');
      return reply.code(503).send({
        available: false,
        error: 'apps service unavailable',
        apps: [],
        dynamicEnabled: config.appsDynamicEnabled,
        jobs: jobList,
      });
    }
  });

  // Create (or regenerate) an app: POST {name, type:'static'|'dynamic', prompt}
  app.post('/api/apps', { preHandler: verifyAuth }, async (req, reply) => {
    const { name, type = 'static', prompt } = req.body ?? {};
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return reply.code(400).send({ error: 'name must match ^[a-z0-9][a-z0-9-]{0,39}$' });
    }
    if (type !== 'static' && type !== 'dynamic') return reply.code(400).send({ error: 'bad type' });
    if (typeof prompt !== 'string' || !prompt.trim()) return reply.code(400).send({ error: 'prompt is required' });
    if ([...jobs.values()].some((j) => j.name === name && j.status === 'running')) {
      return reply.code(409).send({ error: 'a generation job for this app is already running' });
    }

    const dir = path.join(config.appsDir, name);
    await fs.mkdir(dir, { recursive: true });
    if (type === 'static') {
      // Written up-front so the watcher mounts the app as soon as index.html lands.
      await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify({ name, type: 'static' }, null, 2) + '\n');
    }

    const job = {
      id: uuidv4(),
      name,
      type,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      total: 0,
      log: [],
    };
    const push = (line) => {
      job.total += 1;
      job.log.push(line);
      if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    };

    const fullPrompt = type === 'static' ? staticPrompt(name, prompt) : dynamicPrompt(name, prompt);
    let r;
    try {
      r = await run(fullPrompt, { cwd: dir, sessionId: uuidv4(), resume: false, roots: [config.appsDir] });
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
    job.run = r;
    jobs.set(job.id, job);
    audit('app_create', { ip: clientIp(req), name, type, pid: r.pid, prompt: prompt.slice(0, 2000) });

    r.on('event', (ev) => summarize(ev).forEach(push));
    r.on('stdout', push);
    r.on('stderr', (l) => push(`[stderr] ${l}`));
    const finish = (status, exitCode) => {
      if (job.status !== 'running') return;
      job.status = status;
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();
      delete job.run;
      audit('app_create_done', { name, status, exitCode });
    };
    r.on('error', (err) => {
      push(`[error] ${err.message}`);
      finish('failed', -1);
    });
    r.on('exit', ({ exitCode }) => finish(exitCode === 0 ? 'done' : 'failed', exitCode));

    // Forget finished jobs after an hour.
    setTimeout(() => jobs.delete(job.id), 3_600_000).unref();

    return reply.code(202).send({ jobId: job.id, name, type, url: `/apps/${name}/` });
  });

  app.get('/api/apps/jobs/:id', { preHandler: verifyAuth }, async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    // `total` counts every line ever logged; `log` keeps only the newest ones.
    const since = Number.parseInt(req.query?.since ?? '0', 10) || 0;
    const { run: _r, log, ...rest } = job;
    const offset = job.total - log.length;
    return { ...rest, lines: log.slice(Math.max(0, since - offset)) };
  });

  app.post('/api/apps/jobs/:id/cancel', { preHandler: verifyAuth }, async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    job.run?.cancel();
    return { ok: true };
  });

  app.delete('/api/apps/:name', { preHandler: verifyAuth }, async (req, reply) => {
    const { name } = req.params;
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'bad name' });
    const dir = path.join(config.appsDir, name);
    if (!isWithin(config.appsDir, dir) || dir === config.appsDir) return reply.code(400).send({ error: 'bad name' });
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
    audit('app_delete', { ip: clientIp(req), name });
    return { ok: true };
  });
}
