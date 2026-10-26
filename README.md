# CC-Web

A personal, single-user web console for [Claude Code](https://docs.anthropic.com/claude-code). Log in from any browser, phone included. Pick a project directory, send a prompt, and watch `claude -p` stream its work live. Sessions can be resumed later. A second, isolated service hosts small web apps that Claude generates for you, and reloads them as the files change.

It runs on a Linux EC2 host behind CloudFront. CloudFront terminates TLS with an ACM certificate and injects a secret origin header.

> Design rationale and threat model: [DESIGN.md](DESIGN.md).

## Features

- **Single admin account.** No registration. bcrypt password hash, JWT stored in an `HttpOnly` + `Secure` + `SameSite=Strict` cookie, per-IP exponential login lockout, and an Origin check on every write.
- **Connection-independent tasks.** A prompt becomes a *job* (`POST /api/sessions/:id/jobs`). `claude -p --output-format stream-json --verbose --include-partial-messages` is spawned detached, with stdout/stderr going straight to `data/jobs/<id>.out` / `.err`. Closing the tab, losing the network, the phone sleeping, even restarting core: none of these stop it. A restarted core re-adopts running jobs. One running job per session; a retried submit with the same `clientRequestId` returns the original job instead of starting a second one. Status (`running` / `done` / `failed` / `cancelled`) is kept in `data/jobs/<id>.json`. Jobs can be cancelled (SIGTERM to the process group, then SIGKILL).
- **Weak-network friendly output.** The browser follows a job by byte cursor: pushed over WebSocket (`/ws/run`) when it works, HTTP long-polling (`GET /api/jobs/:id/events?cursor=&wait=`) when it does not. It switches between them on its own. Each batch carries the cursor it starts from, so nothing is shown twice or skipped. Streaming deltas already superseded by a complete message are dropped server-side, so catching up after an hour offline costs about as much as the final messages.
- **ChatGPT-style UI.** Collapsible chat sidebar (a drawer on phones), centred thread, bottom composer (Enter sends, Shift+Enter adds a newline), text streamed in as it is typed, a stop button, copy buttons on messages and code blocks, and tool calls / thinking folded into "Used N tools" groups. Opening a chat loads its history from Claude Code's own transcript (`GET /api/sessions/:id/history`), plus the latest job's own event log.
- **Sessions.** Each session gets a uuid passed as `--session-id`. Later runs use `--resume`. Session metadata lives in `data/sessions.json`.
- **cwd whitelist.** Paths must sit under `ALLOWED_ROOTS`. Each path goes through `path.resolve` and `realpath`, which blocks `../` traversal and symlink escapes. A directory browser lets you pick a cwd instead of typing one.
- **Origin guard.** When `ORIGIN_SECRET` is set, any request without CloudFront's `X-Origin-Secret` header gets `403`.
- **Apps service.** A separate process bound to `127.0.0.1`:
  - It watches `apps/` with chokidar and hot-reloads.
  - **Static apps** are served directly.
  - **Dynamic apps** (off by default) run as supervised Node child processes: health checks, exponential-backoff restarts, and a circuit breaker.
  - Core proxies `/apps/*` to it, behind login. If the apps service is down, the console still works and `/apps/*` returns a friendly 503.
- **Audit log** at `data/audit.log`: logins, runs (cwd + prompt), and app creation and deletion.
- **systemd units** for both services. The apps unit runs with `MemoryMax=512M`, `CPUQuota=50%` and a read-only filesystem.

## Architecture

```
browser ──HTTPS──▶ CloudFront ──HTTP :8787 + X-Origin-Secret──▶ core (Fastify, 0.0.0.0)
                                                               ├─ /api/*   auth, dirs, sessions, jobs (start/poll/cancel), apps API
                                                               ├─ /ws/run  push job events (optional; HTTP polling works alone)
                                                               ├─ /        static SPA (packages/core/public)
                                                               └─ /apps/*  ──proxy──▶ apps service (127.0.0.1:8788)
                                                                                     ├─ static apps/<name>/
                                                                                     └─ dynamic: node <entry> on 127.0.0.1:<port>
```

```
cc-web/
├─ packages/core/     console backend + SPA (never runs app code)
├─ packages/apps/     isolated apps host
├─ apps/              generated apps (gitignored; see apps/README.md for app.json)
├─ data/              sessions.json, audit.log, jobs/ (gitignored)
├─ scripts/           hash-pass.js, dev.js
└─ deploy/            install.sh, systemd units, cloudfront.md
```

## Local development

Requires **Node.js 20.12+** and the `claude` CLI on your `PATH`, logged in.

```bash
git clone <this repo> cc-web && cd cc-web
npm install
cp .env.example .env

# 1. Create the admin password hash and paste it into .env as ADMIN_PASS_HASH='...'
npm run hash-pass -- 'a-long-password'

# 2. Point ALLOWED_ROOTS at a directory of projects (comma-separated, absolute paths)
#    or leave it empty to use ./workspace

# 3. Run both services (auto-restart on file changes)
npm run dev
#   or separately:  npm run start:core   /   npm run start:apps
```

Open <http://localhost:8787> and log in.

- Both services boot without a `.env`. With no `JWT_SECRET`, a random per-process secret is used. With no `ADMIN_PASS_HASH`, login is disabled. With no `ORIGIN_SECRET`, the origin check is off. Each case logs a warning.
- The session cookie is `Secure`. Chrome and Firefox accept `Secure` cookies on `http://localhost`, but Safari does not: set `COOKIE_SECURE=false` for local testing in Safari only.
- In `-p` mode Claude cannot ask for permission interactively. `CLAUDE_EXTRA_ARGS=--permission-mode acceptEdits` lets it edit files. Choose a mode you are comfortable with.
- Flag names differ between Claude Code versions. Run `claude --help` on the target machine and check that `-p`, `--output-format stream-json`, `--verbose`, `--session-id` and `--resume` all exist.

## Configuration

Every key is documented in [`.env.example`](.env.example). Summary:

| Key | Default | Purpose |
|---|---|---|
| `PORT_CORE` | `8787` | Console port (0.0.0.0) — the CloudFront origin port |
| `PORT_APPS` | `8788` | Apps service port (127.0.0.1 only) |
| `APPS_SERVICE_URL` | `http://127.0.0.1:8788` | Where core proxies `/apps/*` |
| `ADMIN_USER` / `ADMIN_PASS_HASH` | `qpj` / — | Login; hash from `npm run hash-pass` |
| `JWT_SECRET` | random per boot | Session signing key |
| `SESSION_TTL_HOURS` | `12` | Cookie / JWT lifetime |
| `COOKIE_SECURE` | `true` | `Secure` cookie flag |
| `ORIGIN_SECRET` | — | Required `X-Origin-Secret` value (enforced only if set) |
| `TRUST_PROXY` | `true` | Client IP = right-most `X-Forwarded-For` |
| `LOGIN_LOCK_MAX_SEC` / `LOGIN_LOCK_RESET_MIN` | `3600` / `1440` | Exponential per-IP lockout: n-th failure locks for 3^(n-1) s up to the cap; counter forgotten after the reset window |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where Claude Code transcripts are read from for session history |
| `HISTORY_MAX_BYTES` / `HISTORY_MAX_MESSAGES` | `33554432` / `500` | History API limits: bytes read from the end of a transcript / messages returned |
| `ALLOWED_ROOTS` | `./workspace` | cwd whitelist (comma-separated) |
| `CLAUDE_BIN` / `CLAUDE_EXTRA_ARGS` | `claude` / — | CLI path and extra flags |
| `MAX_CONCURRENT_RUNS` | `2` | Global cap on claude processes (chat jobs + app generation) |
| `JOBS_RETENTION_DAYS` | `30` | Finished jobs' logs in `data/jobs/` are deleted after this many days |
| `APPS_DIR` | `./apps` | Generated apps |
| `APPS_DYNAMIC_ENABLED` | `false` | Run dynamic apps (dangerous) |
| `APPS_SANDBOX` | `true` | CSP sandbox on `/apps/*` responses |
| `DATA_DIR` | `./data` | sessions.json, audit.log |
| `LOG_LEVEL` | `info` | Fastify/pino log level |

## Deploy to a fresh Linux EC2 instance (one shot)

These steps were written for **Amazon Linux 2023** and **Ubuntu 22.04/24.04**. Run them on the second machine.

### 1. Launch the instance

- Use any small instance (t3.small or larger). Give it a public DNS name.
- Security group for now: SSH (22) from your IP only. **Do not** open 8787 to the world. Step 6 opens it to CloudFront only.

### 2. Clone and install

```bash
sudo dnf install -y git || sudo apt-get install -y git
git clone <this repo> ~/cc-web
cd ~/cc-web
sudo bash deploy/install.sh
```

`install.sh` is idempotent. Re-run it after every `git pull` to update. It does the following:

1. Installs Node.js LTS from NodeSource if Node is missing or older than 20, plus build tools, `rsync` and `acl`.
2. Creates the `ccweb` system user, with home directory `/home/ccweb`.
3. Syncs the repo to **`/opt/cc-web`** (override with `INSTALL_DIR=...`). `apps/`, `data/` and `.env` are never overwritten.
4. Runs `npm ci --omit=dev` as `ccweb`, falling back to `npm install` when there is no lockfile.
5. Writes **`/etc/cc-web/env`** (`chmod 600`, owned by root) with a freshly generated `JWT_SECRET` and `ORIGIN_SECRET`, unless the file already exists. In that case it only fills secrets that are empty.
6. Installs `cc-web-core.service` and `cc-web-apps.service`, runs `daemon-reload` and enables both units. It does **not** start them.

### 3. Install and log in to Claude Code as `ccweb`

Claude credentials belong to the user that runs the backend:

```bash
sudo -u ccweb -i bash -c 'curl -fsSL https://claude.ai/install.sh | bash'   # or: sudo npm i -g @anthropic-ai/claude-code
sudo -u ccweb -i claude          # finish the login flow once, then /exit
sudo -u ccweb -i claude --help   # confirm the -p / stream-json / --session-id / --resume flags
```

### 4. Edit `/etc/cc-web/env`

```bash
cd /opt/cc-web && sudo -u ccweb npm run hash-pass -- 'a-long-unique-password'
sudo nano /etc/cc-web/env
```

Set at least the following:

- `ADMIN_PASS_HASH='$2b$12$...'`. Single quotes are fine; values are never `$`-expanded.
- `ALLOWED_ROOTS=/home/ec2-user/projects`, or wherever your repos live. Then give `ccweb` access to it:
  ```bash
  sudo mkdir -p /home/ec2-user/projects
  sudo setfacl -m u:ccweb:x /home/ec2-user
  sudo setfacl -R -m u:ccweb:rwX,d:u:ccweb:rwX /home/ec2-user/projects
  ```
- `CLAUDE_BIN`. This is auto-detected. If you installed Claude after running `install.sh`, set it to `/home/ccweb/.local/bin/claude`.
- Leave `ORIGIN_SECRET` and `JWT_SECRET` as generated. Copy `ORIGIN_SECRET`; you need it for CloudFront.

### 5. Start both services

```bash
sudo systemctl start cc-web-core cc-web-apps
sudo systemctl status cc-web-core cc-web-apps --no-pager
curl -s http://127.0.0.1:8787/healthz                           # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/  # 403 = origin guard is on
journalctl -u cc-web-core -f
```

The two units do not depend on each other. Restarting or crashing `cc-web-apps` never affects the console.

### 6. CloudFront and the security group

The full checklist is in [`deploy/cloudfront.md`](deploy/cloudfront.md). In short:

1. **ACM certificate in `us-east-1`.** CloudFront only uses certificates from N. Virginia. Request one for your domain with DNS validation. If you have no domain, use the default `*.cloudfront.net` certificate.
2. **Custom origin.** Use the EC2 **public DNS name**, protocol **HTTP only**, HTTP port **8787**. CloudFront supports arbitrary origin ports 1024–65535. Set the response timeout to 60 s.
3. **Origin custom header.** `X-Origin-Secret: <ORIGIN_SECRET from /etc/cc-web/env>`. Core answers `403` to every request that lacks it.
4. **Behaviors.** Create `/api/*`, `/ws/*` and `/apps/*` with **Managed-CachingDisabled** and **Managed-AllViewer**, all HTTP methods allowed, and *Redirect HTTP to HTTPS*. AllViewer forwards `Cookie`, `Origin`, `Host` and the WebSocket upgrade headers. Without it, login and streaming break. The default behavior (`*`) can use CachingDisabled + AllViewer too, which is simplest, or a caching policy for `/`, `/app.js` and `/style.css`.
5. **Alternate domain name.** Add your domain and the ACM certificate, then point a DNS CNAME or alias at the distribution.
6. **Security group.** Inbound TCP **8787** from the AWS managed prefix list **`com.amazonaws.global.cloudfront.origin-facing`** *only*. Remove any `0.0.0.0/0` rule. Never open 8788.
7. You need both the prefix-list rule and the secret header. Every CloudFront customer shares the prefix list; only the header proves the request came from *your* distribution.
8. Optional: put **AWS WAF** in front, with a rate-based rule, geo restriction and the managed common rule set.

Verify: `https://<your-domain>/` shows the login page. A direct `http://<ec2-dns>:8787/` from the internet times out.

### Updating

```bash
cd ~/cc-web && git pull && sudo bash deploy/install.sh && sudo systemctl restart cc-web-core cc-web-apps
```

## ⚠️ Security warning: dynamic apps

`APPS_DYNAMIC_ENABLED=true` makes the server **execute arbitrary code written by an LLM**. Any prompt injection that reaches Claude, for example through a web page or a file it reads, can end up as code running on your host. It is off by default. If you turn it on, these mitigations are in place, but they reduce the risk rather than remove it:

- Dynamic apps run inside `cc-web-apps.service`: a separate process from the console, with `MemoryMax=512M`, `CPUQuota=50%`, `TasksMax=256`, `ProtectSystem=strict`, write access only to `APPS_DIR`, and `ProtectHome=true`.
- Each child gets a minimal environment with **no** console secrets. It listens on loopback only and is reachable only through the authenticated `/apps/*` proxy.
- Core strips its session cookie and the origin secret from every proxied request. It also drops any `Set-Cookie` that tries to overwrite the session.
- `APPS_SANDBOX=true` (the default) adds `Content-Security-Policy: sandbox …` to `/apps/*` responses. App pages run in an opaque origin and cannot call `/api/*` as you. **Do not disable it** unless you trust every app.

Running `claude` itself is equivalent to shell access inside `ALLOWED_ROOTS`, as the `ccweb` user. Keep that user unprivileged: no sudo, and no write access outside the roots. Consider containers or bubblewrap if you need more isolation.

## Implementation notes

- `/apps/*` HTTP is proxied with `@fastify/http-proxy`. WebSocket upgrades on `/apps/*` go through a small raw-socket tunnel in `packages/core/src/appsProxy.js` instead of http-proxy's `websocket: true` option. That option adds its own server `upgrade` listener, which would conflict with `@fastify/websocket` (used by `/ws/run`) on the same server. The tunnel enforces the same origin secret, Origin check and session checks.
- `/ws/run` sends WebSocket ping frames every 20 s, so CloudFront does not drop idle connections during long tool runs. While subscribed it also sends at least one (possibly empty) batch every 25 s. If the browser hears nothing for 40 s, it treats the socket as dead and switches to polling.
- Long-polls wait at most 25 s, well under CloudFront's 60 s origin timeout.
- `cc-web-core.service` uses `KillMode=process`, so `systemctl restart cc-web-core` stops only node. Running claude jobs continue and are re-adopted. The new core checks that the pid is still alive and that its cmdline contains the Claude session id. `systemctl stop` therefore leaves running jobs alone too. To kill them, cancel them in the UI first. For the same reason the core unit has no `PrivateTmp` (systemd wipes it on restart), and jobs get `TMPDIR=DATA_DIR/tmp`.
- Job event API: `{job, from, cursor, events, more}`. Events are compact view objects (`init`, `delta`, `assistant`, `user`, `result`) whose content blocks use the history API's shape. Claude's raw stream-json stays complete in `data/jobs/<id>.out`.

## License

MIT
