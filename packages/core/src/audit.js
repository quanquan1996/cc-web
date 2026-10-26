// Append-only audit trail (who / when / where / what) in DATA_DIR/audit.log.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'audit.log');

export function audit(action, details = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, ...details }) + '\n';
  fs.appendFile(file, line, () => {});
}
