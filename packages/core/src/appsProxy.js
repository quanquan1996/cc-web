// Reverse proxy /apps/* -> isolated apps service (APPS_SERVICE_URL).
//
// HTTP goes through @fastify/http-proxy. WebSocket upgrades for /apps/* are
// tunnelled by a small raw-socket proxy instead of http-proxy's `websocket`
// option: that option installs its own server 'upgrade' listener, which would
// double-handle upgrades next to @fastify/websocket (used by /ws/run) in the
// same server. The tunnel re-checks origin secret + session itself because it
// runs outside Fastify's hook chain.
import net from 'node:net';
import httpProxy from '@fastify/http-proxy';
import { config, COOKIE_NAME } from './config.js';
import { verifyToken, originAllowed, clientIp } from './auth.js';
import { originSecretOk } from './originGuard.js';

const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const UNAVAILABLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apps unavailable</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}a{color:#7aa2f7}</style></head>
<body><main><h1>Apps service is unavailable</h1>
<p>The isolated apps host is down or restarting. The console itself is unaffected.</p>
<p><a href="/">Back to console</a></p></main></body></html>`;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

// Never leak the console session cookie or the origin secret to app code.
function stripCookie(header) {
  if (!header) return header;
  const kept = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${COOKIE_NAME}=`));
  return kept.length ? kept.join('; ') : undefined;
}

async function appsAuth(req, reply) {
  if (verifyToken(req.cookies?.[COOKIE_NAME])) return;
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (req.method === 'GET' && wantsHtml) {
    return reply.redirect(`/?next=${encodeURIComponent(req.url)}`, 302);
  }
  return reply.code(401).send({ error: 'unauthorized' });
}

export async function registerAppsProxy(app) {
  await app.register(httpProxy, {
    upstream: config.appsServiceUrl,
    prefix: '/apps',
    rewritePrefix: '/apps',
    websocket: false,
    preHandler: appsAuth,
    replyOptions: {
      rewriteRequestHeaders: (req, headers) => {
        const h = { ...headers };
        const cookie = stripCookie(h.cookie);
        if (cookie) h.cookie = cookie;
        else delete h.cookie;
        delete h['x-origin-secret'];
        h['x-forwarded-for'] = clientIp(req);
        return h;
      },
      rewriteHeaders: (headers) => {
        const h = { ...headers };
        // Drop any attempt by an app to overwrite the console session cookie.
        if (h['set-cookie']) {
          const list = (Array.isArray(h['set-cookie']) ? h['set-cookie'] : [h['set-cookie']]).filter(
            (c) => !String(c).trim().startsWith(`${COOKIE_NAME}=`),
          );
          if (list.length) h['set-cookie'] = list;
          else delete h['set-cookie'];
        }
        if (config.appsSandbox) {
          const csp = h['content-security-policy'];
          h['content-security-policy'] = csp ? `${csp}; ${SANDBOX_CSP}` : SANDBOX_CSP;
        }
        return h;
      },
      onError: (reply, arg) => {
        const error = arg?.error ?? arg;
        reply.log.warn({ err: error?.message }, 'apps service unreachable');
        reply.code(503).type('text/html; charset=utf-8').send(UNAVAILABLE_HTML);
      },
    },
  });
}

function rejectUpgrade(socket, code, text) {
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function tunnelToApps(req, socket, head) {
  if (!originSecretOk(req.headers)) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!originAllowed(req.headers)) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
    return rejectUpgrade(socket, 401, 'Unauthorized');
  }

  const target = new URL(config.appsServiceUrl);
  const port = Number(target.port) || 80;
  const upstream = net.connect(port, target.hostname);
  let connected = false;

  upstream.on('connect', () => {
    connected = true;
    const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${target.host}`];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i];
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'x-origin-secret' || lower === 'x-forwarded-for') continue;
      if (lower === 'cookie') {
        const c = stripCookie(raw[i + 1]);
        if (c) lines.push(`Cookie: ${c}`);
        continue;
      }
      lines.push(`${name}: ${raw[i + 1]}`);
    }
    lines.push(`X-Forwarded-For: ${clientIp(req)}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => {
    if (!connected) rejectUpgrade(socket, 503, 'Service Unavailable');
    else socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

/** Call after app.ready(): route /apps/* upgrades to the tunnel, everything
 *  else to the listeners that were already installed (@fastify/websocket). */
export function installAppsWsTunnel(app) {
  const server = app.server;
  const original = server.listeners('upgrade');
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    if (p === '/apps' || p.startsWith('/apps/')) return tunnelToApps(req, socket, head);
    if (original.length === 0) return socket.destroy();
    for (const fn of original) fn.call(server, req, socket, head);
  });
}
