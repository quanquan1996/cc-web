// GET /api/sessions/:id/history — read Claude Code's own transcript
// (~/.claude/projects/<slug>/<claude-session-id>.jsonl), drop bookkeeping
// lines and return the conversation as structured messages:
//
//   { role: 'user'|'assistant', uuid, timestamp, blocks: [
//       { type: 'text', text } | { type: 'thinking', text }
//     | { type: 'tool_use', id, name, input, result?: { text, isError, truncated } }
//     | { type: 'tool_result', toolUseId, text, isError, truncated }   // orphan
//     | { type: 'image' } ] }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { validate as uuidValidate } from 'uuid';
import { config } from './config.js';
import { verifyAuth } from './auth.js';
import { getSession } from './sessions.js';

const MAX_TEXT = 20_000; // per tool input / tool result, so one huge Read can't bloat the response

/** Locate <id>.jsonl: try the slug derived from cwd, then scan every project dir. */
export async function findTranscript(claudeId, cwd) {
  if (!uuidValidate(claudeId)) return null;
  const root = config.claudeProjectsDir;
  const name = `${claudeId}.jsonl`;
  const candidates = [];
  if (cwd) candidates.push(path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name));
  try {
    for (const d of await fsp.readdir(root, { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(root, d.name, name));
    }
  } catch {
    /* no projects dir yet */
  }
  for (const file of candidates) {
    try {
      if ((await fsp.stat(file)).isFile()) return file;
    } catch {
      /* try next */
    }
  }
  return null;
}

function clip(s) {
  return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), truncated: true } : { text: s, truncated: false };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

function clipInput(input) {
  const s = JSON.stringify(input ?? {});
  return s.length > MAX_TEXT ? { _truncated: s.slice(0, MAX_TEXT) } : input;
}

/** Folds transcript entries into messages. Consecutive assistant entries (one
 *  per content block in the jsonl) form a single assistant turn; tool_result
 *  entries are attached to their tool_use instead of becoming user messages. */
export class HistoryBuilder {
  constructor() {
    this.messages = [];
    this.toolUses = new Map(); // tool_use id -> block
  }

  add(entry) {
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) return;
    if (entry.isSidechain || entry.isMeta) return;
    const content = entry.message?.content;
    const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const blocks = [];
    for (const b of items) {
      if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'image') blocks.push({ type: 'image' });
      else if (b.type === 'tool_use') {
        const block = { type: 'tool_use', id: b.id, name: b.name, input: clipInput(b.input) };
        this.toolUses.set(b.id, block);
        blocks.push(block);
      } else if (b.type === 'tool_result') {
        const { text, truncated } = clip(resultText(b.content));
        const owner = this.toolUses.get(b.tool_use_id);
        if (owner) owner.result = { text, isError: Boolean(b.is_error), truncated };
        else blocks.push({ type: 'tool_result', toolUseId: b.tool_use_id, text, isError: Boolean(b.is_error), truncated });
      }
    }
    if (!blocks.length) return;
    const role = entry.type;
    const last = this.messages[this.messages.length - 1];
    if (role === 'assistant' && last?.role === 'assistant') {
      last.blocks.push(...blocks);
      return;
    }
    this.messages.push({ role, uuid: entry.uuid ?? null, timestamp: entry.timestamp ?? null, blocks });
  }
}

/** Reads at most historyMaxBytes from the end of the file and keeps the last
 *  historyMaxMessages messages. */
export async function readHistory(file) {
  const { size } = await fsp.stat(file);
  const start = Math.max(0, size - config.historyMaxBytes);
  const builder = new HistoryBuilder();
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { start, encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let first = start > 0; // first line is probably cut in half
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    // Cheap pre-filter: most lines are api-request blobs and other bookkeeping.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    builder.add(entry);
  }
  const all = builder.messages;
  const max = config.historyMaxMessages;
  return { messages: all.length > max ? all.slice(-max) : all, truncated: start > 0 || all.length > max };
}

export function registerHistory(app) {
  app.get('/api/sessions/:id/history', { preHandler: verifyAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!uuidValidate(id)) return reply.code(400).send({ error: 'bad id' });
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const claudeId = session.claudeSessionId || session.id;
    const file = await findTranscript(claudeId, session.cwd);
    if (!file) return { sessionId: id, messages: [], truncated: false };
    try {
      return { sessionId: id, ...(await readHistory(file)) };
    } catch (err) {
      req.log.warn({ err, id }, 'history read failed');
      return { sessionId: id, messages: [], truncated: false };
    }
  });
}
