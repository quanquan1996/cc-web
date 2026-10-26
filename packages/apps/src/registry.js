// In-memory app registry: name -> { type, status, pid?, port?, mountPath, ... }.
// status: ready | pending | invalid (static) — starting | running | restarting
//         | failed | stopped | disabled (dynamic)
const apps = new Map();

export function add(name, entry) {
  const prev = apps.get(name);
  const next = {
    name,
    mountPath: `/apps/${name}/`,
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  apps.set(name, next);
  return { prev, next };
}

/** Patch an existing entry (no-op if it was removed meanwhile). */
export function update(name, patch) {
  const cur = apps.get(name);
  if (!cur) return null;
  Object.assign(cur, patch, { updatedAt: new Date().toISOString() });
  return cur;
}

export function remove(name) {
  const prev = apps.get(name);
  apps.delete(name);
  return prev ?? null;
}

export function get(name) {
  return apps.get(name) ?? null;
}

/** Public view (no internal fields like dir). */
export function list() {
  return [...apps.values()]
    .map(({ name, type, status, pid, port, mountPath, error, restarts, updatedAt }) => ({
      name,
      type,
      status,
      pid: pid ?? null,
      port: port ?? null,
      mountPath,
      error: error ?? null,
      restarts: restarts ?? 0,
      updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
