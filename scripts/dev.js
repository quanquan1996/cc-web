#!/usr/bin/env node
// Local dev: run core and apps side by side with `node --watch`, prefixed output.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = [
  { name: 'core', entry: 'packages/core/src/server.js', watch: ['packages/core/src'], color: 36 },
  { name: 'apps', entry: 'packages/apps/src/server.js', watch: ['packages/apps/src'], color: 35 },
];

const children = services.map((s) => {
  const args = [...s.watch.flatMap((w) => ['--watch-path', path.join(root, w)]), path.join(root, s.entry)];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m `;
  const relay = (stream, out) => {
    let buf = '';
    stream.on('data', (c) => {
      buf += c;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag}exited with ${code}`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
