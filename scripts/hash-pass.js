#!/usr/bin/env node
// Print a bcrypt hash for ADMIN_PASS_HASH.
//   node scripts/hash-pass.js 'my password'
//   npm run hash-pass -- 'my password'
//   node scripts/hash-pass.js            (prompts; input is not echoed on a TTY)
import bcrypt from 'bcrypt';
import readline from 'node:readline';

const COST = 12;

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute echo while typing the password.
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

let password = process.argv[2];
if (!password) {
  if (!process.stdin.isTTY) {
    console.error('usage: node scripts/hash-pass.js <password>');
    process.exit(1);
  }
  password = await promptHidden('Password: ');
}
if (!password || password.length < 8) {
  console.error('error: use a password of at least 8 characters');
  process.exit(1);
}

const hash = await bcrypt.hash(password, COST);
console.log(hash);
console.error(`\nAdd to .env or /etc/cc-web/env (single quotes keep the $ signs literal):\nADMIN_PASS_HASH='${hash}'`);
