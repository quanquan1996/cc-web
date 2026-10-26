// CC-Web core: the stable console process. It authenticates the admin, runs
// `claude -p` and proxies /apps/* to the separate apps service. It never
// executes generated app code itself.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { registerOriginGuard } from './originGuard.js';
import { registerAuth } from './auth.js';
import { registerDirs } from './dirs.js';
import { registerSessions } from './sessions.js';
import { registerHistory } from './history.js';
import { registerJobs, releaseWaiters } from './jobs.js';
import { registerWs } from './ws.js';
import { registerAppsApi } from './appsApi.js';
import { registerAppsProxy, installAppsWsTunnel } from './appsProxy.js';
import { activeRuns } from './runner.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: 1024 * 1024,
  // Client IPs are derived explicitly in auth.clientIp (right-most XFF).
  trustProxy: false,
});

// 1. Origin guard first: everything except /healthz needs CloudFront's header.
registerOriginGuard(app);

// Baseline security headers for console responses (/apps/* sets its own CSP).
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  if (!req.url.startsWith('/apps')) reply.header('X-Frame-Options', 'DENY');
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  return payload;
});

await app.register(fastifyCookie);
await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

app.get('/healthz', async () => ({ ok: true, activeRuns: activeRuns() }));

registerAuth(app);
registerDirs(app);
registerSessions(app);
registerHistory(app);
registerJobs(app);
registerWs(app);
registerAppsApi(app);
await registerAppsProxy(app);

await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'] });

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
  return reply.code(404).type('text/plain').send('Not found');
});

for (const w of config.warnings) app.log.warn(w);

await app.ready();
installAppsWsTunnel(app);

try {
  await app.listen({ port: config.portCore, host: '0.0.0.0' });
  app.log.info(
    { allowedRoots: config.allowedRoots, appsService: config.appsServiceUrl, originGuard: Boolean(config.originSecret) },
    'cc-web core ready',
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (sig) => {
  app.log.info({ sig }, 'shutting down');
  // Running claude jobs are detached and are re-adopted by the next process.
  releaseWaiters();
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
