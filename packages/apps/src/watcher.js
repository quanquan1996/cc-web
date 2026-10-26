// Hot reload: watch APPS_DIR (depth 1) and reconcile each touched app.
// Any event below apps/<name>/ schedules a debounced reconcile(name) which
// re-reads app.json and (re)mounts, restarts or removes the app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { watch } from 'chokidar';
import { config } from './config.js';
import * as registry from './registry.js';
import { mountStatic, unmountStatic } from './static.js';
import { startDynamic, stopDynamic } from './dynamic.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEBOUNCE_MS = 400;

let log = console;
const timers = new Map(); // name -> debounce timer
const queue = new Map(); // name -> in-flight reconcile promise (serializes per app)

/**
 * Manifest (apps/<name>/app.json):
 *   { "name": string, "type": "static" | "dynamic", "entry"?: string, "port"?: number }
 * A directory without app.json is treated as a static app.
 */
async function readManifest(dir, name) {
  let raw;
  try {
    raw = await fs.readFile(path.join(dir, 'app.json'), 'utf8');
  } catch {
    return { name, type: 'static' };
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (err) {
    return { name, type: 'invalid', error: `app.json is not valid JSON: ${err.message}` };
  }
  if (!m || typeof m !== 'object') return { name, type: 'invalid', error: 'app.json must be an object' };
  if (m.name && m.name !== name) log.warn({ app: name, manifestName: m.name }, 'app.json name differs from directory; using directory name');
  const type = m.type ?? 'static';
  if (type !== 'static' && type !== 'dynamic') return { name, type: 'invalid', error: `unknown type "${type}"` };
  if (m.entry !== undefined && typeof m.entry !== 'string') return { name, type: 'invalid', error: 'entry must be a string' };
  if (m.port !== undefined && !Number.isInteger(m.port)) return { name, type: 'invalid', error: 'port must be an integer' };
  return { name, type, entry: m.entry, port: m.port ?? 0 };
}

async function doReconcile(name) {
  const dir = path.join(config.appsDir, name);
  let isDir = false;
  try {
    isDir = (await fs.stat(dir)).isDirectory();
  } catch {
    /* removed */
  }

  const prev = registry.get(name);
  if (!isDir) {
    if (prev?.type === 'dynamic') await stopDynamic(name);
    else unmountStatic(name);
    if (prev) log.info({ app: name }, 'app removed');
    return;
  }

  const manifest = await readManifest(dir, name);
  if (manifest.type === 'invalid') {
    if (prev?.type === 'dynamic') await stopDynamic(name, { keepEntry: true });
    registry.add(name, { type: 'invalid', status: 'invalid', dir, error: manifest.error });
    return;
  }
  if (manifest.type === 'static') {
    if (prev?.type === 'dynamic') await stopDynamic(name, { keepEntry: true });
    await mountStatic(name, dir);
  } else {
    await startDynamic(name, dir, manifest);
  }
  log.info({ app: name, type: manifest.type, status: registry.get(name)?.status }, 'app (re)loaded');
}

export function reconcile(name) {
  const prev = queue.get(name) ?? Promise.resolve();
  const next = prev
    .then(() => doReconcile(name))
    .catch((err) => log.error({ app: name, err: err.message }, 'reconcile failed'))
    .finally(() => {
      if (queue.get(name) === next) queue.delete(name);
    });
  queue.set(name, next);
  return next;
}

function schedule(name) {
  clearTimeout(timers.get(name));
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      reconcile(name);
    }, DEBOUNCE_MS),
  );
}

/** Name of the app a watched path belongs to, or null for top-level files. */
function appNameFor(p) {
  const rel = path.relative(config.appsDir, p);
  if (!rel || rel.startsWith('..')) return null;
  const parts = rel.split(path.sep);
  const name = parts[0];
  return NAME_RE.test(name) ? name : null;
}

/** Initial scan of APPS_DIR (run once on boot). */
export async function scanAll() {
  const entries = await fs.readdir(config.appsDir, { withFileTypes: true });
  await Promise.all(
    entries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => reconcile(e.name)),
  );
}

export function startWatcher(logger) {
  if (logger) log = logger;
  const watcher = watch(config.appsDir, {
    depth: 1,
    ignoreInitial: true,
    ignored: (p) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p),
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  watcher.on('all', (_event, p) => {
    const name = appNameFor(p);
    if (name) schedule(name);
  });
  watcher.on('error', (err) => log.error({ err: err.message }, 'watcher error'));
  return watcher;
}
