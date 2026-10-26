// Session metadata in DATA_DIR/sessions.json. The conversation itself is
// stored by Claude Code under its own session id; we only keep the index.
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { config } from './config.js';
import { verifyAuth } from './auth.js';
import { resolveSafe } from './dirs.js';
import { audit } from './audit.js';

const FILE = path.join(config.dataDir, 'sessions.json');

let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

// Atomic write (tmp + rename), serialized so concurrent updates never interleave.
function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain
    .then(async () => {
      const tmp = `${FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, FILE);
    })
    .catch(() => {});
  return writeChain;
}

export async function listSessions() {
  const all = await load();
  return [...all].sort((a, b) => (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt));
}

export async function getSession(id) {
  return (await load()).find((s) => s.id === id) ?? null;
}

export async function createSession({ title, cwd }) {
  const all = await load();
  const s = {
    id: uuidv4(),
    title: (title || path.basename(cwd) || 'untitled').slice(0, 200),
    cwd,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  all.push(s);
  await persist();
  return s;
}

export async function updateSession(id, patch) {
  const s = await getSession(id);
  if (!s) return null;
  Object.assign(s, patch);
  await persist();
  return s;
}

export async function deleteSession(id) {
  const all = await load();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  await persist();
  return true;
}

export function registerSessions(app) {
  app.get('/api/sessions', { preHandler: verifyAuth }, async () => ({ sessions: await listSessions() }));

  app.post('/api/sessions', { preHandler: verifyAuth }, async (req, reply) => {
    const { cwd, title } = req.body ?? {};
    let real;
    try {
      real = await resolveSafe(cwd);
    } catch (err) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
    const s = await createSession({ title: typeof title === 'string' ? title.trim() : '', cwd: real });
    audit('session_create', { id: s.id, cwd: real });
    return reply.code(201).send(s);
  });

  app.delete('/api/sessions/:id', { preHandler: verifyAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!uuidValidate(id)) return reply.code(400).send({ error: 'bad id' });
    if (!(await deleteSession(id))) return reply.code(404).send({ error: 'not found' });
    audit('session_delete', { id });
    return { ok: true };
  });
}
