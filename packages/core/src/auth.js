// Single-admin auth: bcrypt password check, JWT in an HttpOnly cookie,
// per-IP exponential login lockout and an Origin check for state-changing requests.
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config, COOKIE_NAME } from './config.js';
import { audit } from './audit.js';

const TTL_SEC = config.sessionTtlHours * 3600;
const LOCK_MAX_MS = config.loginLockMaxSec * 1000;
const LOCK_RESET_MS = config.loginLockResetMin * 60_000;

// Used when the user name is wrong so response time does not reveal it.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

/** Real client IP. Behind CloudFront the right-most X-Forwarded-For entry is
 *  the viewer address CloudFront saw; anything left of it is client-supplied. */
export function clientIp(req) {
  const raw = req.raw ?? req;
  if (config.trustProxy) {
    const xff = raw.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return raw.socket?.remoteAddress ?? 'unknown';
}

export function verifyToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return payload.sub === config.adminUser ? payload : null;
  } catch {
    return null;
  }
}

/** CSRF defence in depth (on top of SameSite=Strict): if the browser sent an
 *  Origin header it must match the host the request was addressed to. */
export function originAllowed(headers) {
  const origin = headers.origin;
  if (!origin) return true;
  const host = headers['x-forwarded-host'] || headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** preHandler/preValidation hook: 401 unless a valid session cookie is present. */
export async function verifyAuth(req, reply) {
  const user = verifyToken(req.cookies?.[COOKIE_NAME]);
  if (!user) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  req.user = user;
}

// --- login lockout (exponential backoff per IP) ---------------------------
// The n-th consecutive failure locks the IP for 3^(n-1) s (1, 3, 9, 27 …),
// capped at LOGIN_LOCK_MAX_SEC. The counter is forgotten after
// LOGIN_LOCK_RESET_MIN without failures, or on a successful login.
const failures = new Map(); // ip -> { count, lockedUntil, last }

function lockedFor(ip) {
  const f = failures.get(ip);
  return f ? Math.max(0, f.lockedUntil - Date.now()) : 0;
}

/** Records a failure and returns the new lock duration in ms. */
function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip) ?? { count: 0, lockedUntil: 0, last: 0 };
  f.count += 1;
  f.last = now;
  const lockMs = Math.min(3 ** Math.min(f.count - 1, 30) * 1000, LOCK_MAX_MS);
  f.lockedUntil = now + lockMs;
  failures.set(ip, f);
  return lockMs;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) {
    if (now > f.lockedUntil && now - f.last > LOCK_RESET_MS) failures.delete(ip);
  }
}, 60_000).unref();

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function registerAuth(app) {
  app.decorate('verifyAuth', verifyAuth);

  // Origin check for every non-idempotent API call.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!originAllowed(req.headers)) {
      req.log.warn({ origin: req.headers.origin }, 'cross-origin write rejected');
      return reply.code(403).send({ error: 'bad origin' });
    }
  });

  app.post('/api/login', async (req, reply) => {
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait > 0) {
      const sec = Math.ceil(wait / 1000);
      reply.header('Retry-After', sec);
      return reply.code(429).send({ error: `too many failed attempts, try again in ${sec}s`, retryAfter: sec });
    }
    if (!config.adminPassHash) {
      return reply.code(503).send({ error: 'login not configured (ADMIN_PASS_HASH is empty)' });
    }
    const { user, pass } = req.body ?? {};
    if (typeof user !== 'string' || typeof pass !== 'string' || pass.length > 1024) {
      return reply.code(400).send({ error: 'user and pass are required' });
    }
    const userOk = safeEqual(user, config.adminUser);
    const passOk = await bcrypt.compare(pass, userOk ? config.adminPassHash : DUMMY_HASH);
    if (!userOk || !passOk) {
      const sec = Math.ceil(recordFailure(ip) / 1000);
      req.log.warn({ ip, user, lockSec: sec }, 'login failed');
      audit('login_failed', { ip, user, lockSec: sec });
      reply.header('Retry-After', sec);
      return reply.code(401).send({ error: `invalid credentials, next attempt allowed in ${sec}s`, retryAfter: sec });
    }
    failures.delete(ip);
    const token = jwt.sign({ sub: config.adminUser }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: TTL_SEC,
    });
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: TTL_SEC,
    });
    audit('login', { ip, user });
    return { user: config.adminUser, expiresIn: TTL_SEC };
  });

  app.post('/api/logout', async (req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
    audit('logout', { ip: clientIp(req) });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: verifyAuth }, async (req) => ({
    user: req.user.sub,
    exp: req.user.exp,
    dynamicAppsEnabled: config.appsDynamicEnabled,
  }));
}
