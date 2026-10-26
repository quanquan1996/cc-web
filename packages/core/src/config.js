// Loads ./.env (repo root) without overriding real environment variables and
// exposes a typed config object with dev-friendly defaults.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Minimal dotenv: KEY=VALUE, '#' comments, optional single/double quotes, no expansion.
export function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

loadEnvFile(path.join(REPO_ROOT, '.env'));

const env = process.env;
const str = (k, d = '') => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
const int = (k, d) => {
  const n = Number.parseInt(env[k], 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  if (env[k] === undefined || env[k] === '') return d;
  return /^(1|true|yes|on)$/i.test(env[k]);
};
const fromRoot = (p) => path.resolve(REPO_ROOT, p);

const warnings = [];

let jwtSecret = str('JWT_SECRET');
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  warnings.push('JWT_SECRET is not set: using a random per-process secret (sessions reset on restart).');
}
if (!str('ADMIN_PASS_HASH')) {
  warnings.push('ADMIN_PASS_HASH is not set: login is disabled. Run `npm run hash-pass -- <password>`.');
}
if (!str('ORIGIN_SECRET')) {
  warnings.push('ORIGIN_SECRET is not set: origin header check disabled (OK for local dev only).');
}

let allowedRoots = str('ALLOWED_ROOTS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(fromRoot);
if (allowedRoots.length === 0) {
  const def = path.join(REPO_ROOT, 'workspace');
  fs.mkdirSync(def, { recursive: true });
  allowedRoots = [def];
  warnings.push(`ALLOWED_ROOTS is not set: defaulting to ${def}`);
}

const portApps = int('PORT_APPS', 8788);

export const config = {
  portCore: int('PORT_CORE', 8787),
  portApps,
  appsServiceUrl: str('APPS_SERVICE_URL', `http://127.0.0.1:${portApps}`).replace(/\/+$/, ''),
  adminUser: str('ADMIN_USER', 'qpj'),
  adminPassHash: str('ADMIN_PASS_HASH'),
  jwtSecret,
  originSecret: str('ORIGIN_SECRET'),
  sessionTtlHours: int('SESSION_TTL_HOURS', 12),
  cookieSecure: bool('COOKIE_SECURE', true),
  loginLockMaxSec: Math.max(1, int('LOGIN_LOCK_MAX_SEC', 3600)),
  loginLockResetMin: Math.max(1, int('LOGIN_LOCK_RESET_MIN', 1440)),
  trustProxy: bool('TRUST_PROXY', true),
  allowedRoots,
  claudeBin: str('CLAUDE_BIN', 'claude'),
  claudeExtraArgs: str('CLAUDE_EXTRA_ARGS').split(/\s+/).filter(Boolean),
  claudeProjectsDir: path.resolve(str('CLAUDE_PROJECTS_DIR', path.join(os.homedir(), '.claude', 'projects'))),
  historyMaxBytes: int('HISTORY_MAX_BYTES', 32 * 1024 * 1024),
  historyMaxMessages: int('HISTORY_MAX_MESSAGES', 500),
  maxConcurrentRuns: int('MAX_CONCURRENT_RUNS', 2),
  appsDir: fromRoot(str('APPS_DIR', './apps')),
  appsDynamicEnabled: bool('APPS_DYNAMIC_ENABLED', false),
  appsSandbox: bool('APPS_SANDBOX', true),
  dataDir: fromRoot(str('DATA_DIR', './data')),
  jobsRetentionDays: Math.max(1, int('JOBS_RETENTION_DAYS', 30)),
  logLevel: str('LOG_LEVEL', 'info'),
  warnings,
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.appsDir, { recursive: true });

export const COOKIE_NAME = 'ccweb_session';
