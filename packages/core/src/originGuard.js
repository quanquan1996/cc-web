// Rejects requests that did not come through our CloudFront distribution.
// CloudFront injects "X-Origin-Secret: <ORIGIN_SECRET>" on every origin request;
// direct hits on the EC2 address lack it and get 403. Disabled when unset (dev).
import crypto from 'node:crypto';
import { config } from './config.js';

const HEALTH_PATHS = new Set(['/healthz']);

export function originSecretOk(headers) {
  if (!config.originSecret) return true;
  const got = headers['x-origin-secret'];
  if (typeof got !== 'string') return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(config.originSecret).digest();
  return crypto.timingSafeEqual(a, b);
}

export function registerOriginGuard(app) {
  // Root-level onRequest hook: runs before every route, including plugins
  // registered later (static files, proxy, websocket upgrade routing).
  app.addHook('onRequest', async (req, reply) => {
    const urlPath = req.url.split('?')[0];
    if (HEALTH_PATHS.has(urlPath)) return;
    if (!originSecretOk(req.headers)) {
      req.log.warn({ ip: req.socket.remoteAddress, url: urlPath }, 'origin secret mismatch');
      return reply.code(403).type('text/plain').send('Forbidden');
    }
  });
}
