// Apps-service config. Reads the same repo-root .env as core (without
// overriding real env vars); kept separate so the two packages stay independent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
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
}

loadEnvFile(path.join(REPO_ROOT, '.env'));

const env = process.env;
const int = (k, d) => {
  const n = Number.parseInt(env[k], 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  portApps: int('PORT_APPS', 8788),
  appsDir: path.resolve(REPO_ROOT, env.APPS_DIR || './apps'),
  dynamicEnabled: /^(1|true|yes|on)$/i.test(env.APPS_DYNAMIC_ENABLED || ''),
  logLevel: env.LOG_LEVEL || 'info',
};

fs.mkdirSync(config.appsDir, { recursive: true });
