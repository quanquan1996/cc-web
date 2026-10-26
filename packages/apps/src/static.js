// Static apps: apps/<name>/ served as files under /apps/<name>/.
// Files are read from disk on every request, so edits go live immediately;
// (re)mounting only refreshes the registry entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from './registry.js';

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function mountStatic(name, dir) {
  let status = 'ready';
  try {
    await fs.access(path.join(dir, 'index.html'));
  } catch {
    status = 'pending'; // still being generated
  }
  registry.add(name, { type: 'static', status, dir });
}

export function unmountStatic(name) {
  registry.remove(name);
}

/** Serve `rel` (path below /apps/<name>/) for a static registry entry. */
export async function serveStatic(req, reply, entry, rel) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply.code(405).header('Allow', 'GET, HEAD').send('Method Not Allowed');
  }
  let file = rel || '';
  if (file === '' || file.endsWith('/')) file += 'index.html';

  const root = await fs.realpath(entry.dir).catch(() => null);
  if (!root) return reply.code(404).send('Not found');
  const target = path.resolve(root, file);
  if (!isWithin(root, target)) return reply.code(403).send('Forbidden');

  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    return reply.code(404).type('text/plain').send('Not found');
  }
  // Symlinks pointing outside the app directory are refused.
  if (!isWithin(root, real)) return reply.code(403).send('Forbidden');
  const st = await fs.stat(real);
  if (st.isDirectory()) {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return reply.redirect(`${entry.mountPath}${file}/${q}`, 301);
  }
  // @fastify/static's sendFile (send) also rejects dotfiles and traversal.
  const relPosix = path.relative(root, real).split(path.sep).join('/');
  return reply.sendFile(relPosix, root, { cacheControl: true, maxAge: 0 });
}
