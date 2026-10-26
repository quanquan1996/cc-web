// cwd whitelist: every directory Claude may run in must resolve (after
// following symlinks) to a path inside one of ALLOWED_ROOTS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { verifyAuth } from './auth.js';

export class PathError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** True if `child` equals `parent` or lies beneath it (no prefix tricks like /root2). */
export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Configured roots that exist, as realpaths. */
export async function getRoots(roots = config.allowedRoots) {
  const out = [];
  for (const r of roots) {
    try {
      out.push(await fs.realpath(r));
    } catch {
      // Missing roots are skipped (reported by /api/dirs).
    }
  }
  return out;
}

/**
 * Validate a user-supplied directory. Returns its realpath or throws PathError.
 * Checks the lexical path first (rejects ../ traversal) and then the realpath
 * (rejects symlinks that point outside the roots).
 */
export async function resolveSafe(p, roots = config.allowedRoots) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new PathError('path required');
  if (!path.isAbsolute(p)) throw new PathError('path must be absolute');
  const lexical = path.resolve(p);
  const lexicalRoots = roots.map((r) => path.resolve(r));
  const realRoots = await getRoots(roots);
  if (!lexicalRoots.some((r) => isWithin(r, lexical)) && !realRoots.some((r) => isWithin(r, lexical))) {
    throw new PathError('path is outside the allowed roots', 403);
  }
  let real;
  try {
    real = await fs.realpath(lexical);
  } catch {
    throw new PathError('directory does not exist', 404);
  }
  if (!realRoots.some((r) => isWithin(r, real))) {
    throw new PathError('path escapes the allowed roots (symlink?)', 403);
  }
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new PathError('not a directory');
  return real;
}

export function registerDirs(app) {
  // GET /api/dirs            -> { roots }
  // GET /api/dirs?root=<abs> -> { path, parent, roots, dirs: [{name, path}] }
  app.get('/api/dirs', { preHandler: verifyAuth }, async (req, reply) => {
    const roots = await getRoots();
    const { root, hidden } = req.query ?? {};
    if (!root) {
      const missing = [];
      for (const r of config.allowedRoots) if ((await getRoots([r])).length === 0) missing.push(r);
      return { roots, configured: config.allowedRoots, missing };
    }

    let dir;
    try {
      dir = await resolveSafe(root);
    } catch (err) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .filter((e) => hidden === '1' || !e.name.startsWith('.'))
      .filter((e) => e.name !== 'node_modules')
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), symlink: e.isSymbolicLink() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = path.dirname(dir);
    const parent = parentPath !== dir && roots.some((r) => isWithin(r, parentPath)) ? parentPath : null;
    return { path: dir, parent, roots, dirs };
  });
}
