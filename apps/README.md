# apps/

Runtime directory where the CC-Web **apps service** looks for apps. Every subdirectory `apps/<name>/` becomes an app at `https://<console>/apps/<name>/`, which you can only reach after logging in. The service watches this directory, so adding, changing or deleting an app takes effect within about a second. Nothing needs a restart.

Everything here except this README and `.gitkeep` is gitignored: it is runtime output. You normally create apps from the console's **Apps** tab, which runs `claude -p` with its working directory set to `apps/<name>/`. You can also drop files in by hand.

## Naming

`<name>` must match `^[a-z0-9][a-z0-9-]{0,39}$`, for example `todo` or `weather-board`. Directories with other names are ignored.

## `app.json` schema

```jsonc
{
  "name":  "todo",               // string, should equal the directory name (the directory name wins)
  "type":  "static",             // "static" | "dynamic"            (default: "static")
  "entry": "server.js",          // dynamic only: file run with `node`, relative to the app dir (default: "server.js")
  "port":  0                     // dynamic only: 0 = auto-assign a free port (recommended); 1024–65535 = fixed
}
```

- **No `app.json`:** the directory is treated as a static app.
- **Invalid JSON, an unknown `type`, or the wrong field types:** the app shows status `invalid` with an error, and nothing is served.
- `entry` must resolve to a path inside the app directory.

### Statuses

| type | status | meaning |
|---|---|---|
| static | `ready` | `index.html` exists and is being served |
| static | `pending` | no `index.html` yet (e.g. still generating) |
| dynamic | `starting` | process spawned, waiting for the first healthy check |
| dynamic | `running` | healthy, requests are proxied |
| dynamic | `restarting` | crashed or unhealthy, restarting with exponential backoff (1 s → 30 s) |
| dynamic | `failed` | circuit breaker open: 5 crashes within 60 s. One automatic retry after 5 min, or edit any file to retry now |
| dynamic | `pending` | `entry` file does not exist yet |
| dynamic | `disabled` | `APPS_DYNAMIC_ENABLED` is not `true`, so nothing is run |
| any | `invalid` | bad `app.json` |

## Static apps

Files are served straight from disk under `/apps/<name>/`. A request for a directory serves its `index.html`.

- Use **relative URLs only** (`style.css`, `./js/app.js`). Never use `/style.css`, which would hit the console.
- Dotfiles are not served, and symlinks that point outside the app directory are refused.
- By default (`APPS_SANDBOX=true`) pages get `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`. The page runs in an opaque origin, so it **cannot** call the console API with your session. As a result, `localStorage` and cookies are not available to the app either.

Example: `apps/hello/`

```
apps/hello/
├─ app.json      {"name":"hello","type":"static"}
├─ index.html
└─ style.css
```

```html
<!-- apps/hello/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Hello</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello from a static CC-Web app</h1>
  <button id="b">Click</button> <span id="n">0</span>
  <script>
    let n = 0;
    document.getElementById('b').onclick = () => (document.getElementById('n').textContent = ++n);
  </script>
</body>
</html>
```

## Dynamic apps (off by default)

> **Security warning:** a dynamic app is arbitrary, machine-generated code running on your server. It only runs when you set `APPS_DYNAMIC_ENABLED=true`. Even then it runs inside `cc-web-apps.service`, which has `MemoryMax=512M`, `CPUQuota=50%`, a read-only filesystem except `APPS_DIR`, and a separate process from the console. Review the code before you enable it.

The apps service runs `node <entry>` with the app directory as `cwd` and a **minimal environment**: none of the console's secrets are passed in.

| variable | value |
|---|---|
| `PORT` | port the app **must** listen on |
| `HOST` | `127.0.0.1` (listen only on loopback) |
| `BASE_PATH` | `/apps/<name>/` (public URL prefix) |
| `APP_NAME` | `<name>` |
| `NODE_ENV` | `production` |
| `HOME` | the app directory |

Requests to `/apps/<name>/foo?x=1` are proxied to `http://127.0.0.1:$PORT/foo?x=1`: the prefix is **stripped**, and `X-Forwarded-Prefix: /apps/<name>` is added. WebSocket upgrades are tunnelled the same way. The apps service probes `GET /` every 5 s. Any status below 500 counts as healthy. Three failures in a row, or no healthy probe within 30 s of start, cause a restart.

Example: `apps/counter/`

```json
// apps/counter/app.json
{ "name": "counter", "type": "dynamic", "entry": "server.js", "port": 0 }
```

```js
// apps/counter/server.js — no dependencies, Node >= 20
import http from 'node:http';
import fs from 'node:fs';

const file = new URL('./count.json', import.meta.url);
let count = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).count : 0;

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/increment') {
      count += 1;
      fs.writeFileSync(file, JSON.stringify({ count }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Note the RELATIVE fetch URL: "api/increment", not "/api/increment".
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <h1>Count: <span id="c">${count}</span></h1>
      <button onclick="fetch('api/increment',{method:'POST'}).then(r=>r.json()).then(d=>c.textContent=d.count)">+1</button>`);
  })
  .listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
```

ESM `import` requires `"type": "module"` in a `package.json` next to `server.js`, or a `.mjs` entry. Alternatively, use `require` in a CommonJS `server.js`.
