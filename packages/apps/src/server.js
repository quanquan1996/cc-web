// CC-Web apps service: an isolated process that hosts apps/<name>/ under
// /apps/<name>/. Binds to 127.0.0.1 only; the public path is core's /apps/*
// proxy (which enforces login). Crashes here never take the console down.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import * as registry from './registry.js';
import { serveStatic } from './static.js';
import { proxyHttp, proxyUpgrade, setLogger, stopAll, logsFor, dynamicEnabled } from './dynamic.js';
import { scanAll, startWatcher } from './watcher.js';

const app = Fastify({ logger: { level: config.logLevel } });
setLogger(app.log);

// Keep request bodies as raw streams so they can be piped to dynamic apps.
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', (req, payload, done) => done(null, payload));

// serve:false — we only want reply.sendFile() for registry-driven routing.
await app.register(fastifyStatic, { root: config.appsDir, serve: false });

app.get('/healthz', async () => ({ ok: true, apps: registry.list().length }));

app.get('/api/apps', async () => ({ apps: registry.list(), dynamicEnabled }));

app.get('/api/apps/:name/logs', async (req, reply) => {
  if (!registry.get(req.params.name)) return reply.code(404).send({ error: 'not found' });
  return { lines: logsFor(req.params.name) };
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Index of all apps.
app.get('/apps', (req, reply) => reply.redirect('/apps/', 301));
app.get('/apps/', async (req, reply) => {
  const items = registry
    .list()
    .map((a) => `<li><a href="${esc(a.mountPath)}">${esc(a.name)}</a> <small>${esc(a.type)} · ${esc(a.status)}</small></li>`)
    .join('');
  reply.type('text/html; charset=utf-8');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps</title>
<body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:1.5rem"><h1>Apps</h1><ul>${items || '<li>No apps yet.</li>'}</ul>
<p><a style="color:#7aa2f7" href="/">Back to console</a></p></body>`;
});

// HEAD is added automatically by Fastify for every GET route.
const ALL = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// /apps/<name> -> /apps/<name>/ so relative URLs resolve inside the app.
app.route({
  method: ALL,
  url: '/apps/:name',
  handler: (req, reply) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return reply.redirect(`/apps/${encodeURIComponent(req.params.name)}/${q}`, 301);
  },
});

app.route({
  method: ALL,
  url: '/apps/:name/*',
  handler: async (req, reply) => {
    const entry = registry.get(req.params.name);
    if (!entry) return reply.code(404).type('text/html; charset=utf-8').send(`<h1>No app named "${esc(req.params.name)}"</h1>`);
    if (entry.type === 'static') return serveStatic(req, reply, entry, req.params['*']);
    if (entry.type === 'dynamic') return proxyHttp(req, reply, entry);
    return reply.code(500).type('text/plain').send(`App "${entry.name}" is ${entry.status}: ${entry.error ?? ''}`);
  },
});

// WebSocket upgrades (forwarded by core's tunnel) go straight to dynamic apps.
app.server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  proxyUpgrade(req, socket, head);
});

await scanAll().catch((err) => app.log.error({ err: err.message }, 'initial scan failed'));
const watcher = startWatcher(app.log);

try {
  await app.listen({ port: config.portApps, host: '127.0.0.1' });
  app.log.info({ appsDir: config.appsDir, dynamicEnabled, apps: registry.list().length }, 'cc-web apps service ready');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (sig) => {
  app.log.info({ sig }, 'shutting down');
  await watcher.close().catch(() => {});
  await stopAll().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
