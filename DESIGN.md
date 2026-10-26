# CC-Web 技术方案

个人专属的 Claude Code Web 控制台。单用户、账号密码登录、无注册，运行在公网 Linux EC2 上，通过 `claude -p` 非交互模式驱动 Claude Code。

---

## 1. 目标与范围

### 必须具备
1. 浏览器（含手机）访问，账号密码登录，**无注册入口**，仅一个写死的管理员账号。
2. Web 上提交任务给 Claude Code，流式看到输出。底层用 `claude -p`（print 模式）。
3. 可指定 CC 运行的工作目录（cwd）。
4. 支持 session 续接（`--resume` / `--session-id`），可在 web 上切换多个会话。

### 明确不做（第一版）
- 多用户 / 注册 / 权限分级。
- 真·交互式 pty 终端（本版用 print 模式；若后续要再加）。
- 文件管理器 / 代码编辑器（只做任务提交 + 输出）。

---

## 2. 为什么用 `claude -p` 而不是 pty

`claude -p "<prompt>"` 是一次性非交互模式：喂一个 prompt，执行完输出结果即退出。

| 维度 | pty 包交互式 CLI | `claude -p` print 模式（本方案） |
|---|---|---|
| 实现复杂度 | 高（pty、ANSI、流控、resize） | 低（spawn + 读 stdout） |
| 手机体验 | 终端模拟，手机难用 | 输入框 + 输出区，手机友好 |
| 会话续接 | 进程常驻 | `--resume <id>` / `--session-id` |
| 中途打断 | 原生支持 | kill 子进程 |
| 流式输出 | 原生 | `--output-format stream-json` |

结论：print 模式更稳、更适合公网单用户 + 手机。

### 关键 CLI 用法
```bash
# 流式 JSON 输出，指定工作目录
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --session-id <uuid>          # 首次创建会话
# 续接已有会话
claude -p "<prompt>" --resume <session-id> --output-format stream-json --verbose
```
- `cwd` 通过 `child_process.spawn(cmd, args, { cwd: <目标目录> })` 指定。
- `stream-json` 每行一个 JSON 事件（init / assistant message / tool_use / result 等），后端逐行解析转发给前端。
- 退出码非 0 或 result 事件带 error 时上报失败。

> 注意：不同 Claude Code 版本的 flag 名称/输出 schema 可能有差异。编码前以目标 EC2 上实际 `claude --help` 为准做一次探测，方案里的 flag 作为基线。

---

## 3. 整体架构

```
          手机 / 电脑浏览器
                │ HTTPS (TLS by ACM)
                ▼
        ┌──────────────────────────┐
        │  CloudFront 分发           │  TLS 终止 + ACM 证书
        │  ├─ ACM 证书(us-east-1)    │  + WS 透传(AllViewer)
        │  ├─ 注入自定义 header       │  + /api /ws no-cache
        └──────────┬───────────────┘
                   │ HTTP(S) 回源, 任意端口
                   │ 校验 CloudFront 自定义 header + 源 IP
                   ▼
        ┌──────────────────────────┐
        │   EC2 : Node.js 后端 (Fastify) │
        │  ├─ 源站校验 (X-Origin-Secret) │
        │  ├─ 登录鉴权 (bcrypt+JWT)      │
        │  ├─ /api/sessions            │
        │  ├─ WS /ws/run               │  ← 流式跑 claude -p
        │  └─ 子进程管理 + 路径白名单     │
        └──────────┬───────────────┘
                   │ spawn('claude', [...], {cwd})
                   ▼
            Claude Code CLI (claude -p)
```

- 前端：纯静态 SPA（原生 JS + xterm.js 做输出渲染），由后端托管（也可改放 S3 origin，但单源更简单）。
- TLS 由 CloudFront 用 ACM 证书终止，EC2 后端不管证书。EC2 可直接 HTTP 监听，由 CloudFront→源站这一跳做保护。

---

## 4. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js LTS (20/22) | node-pty 生态；与 claude CLI 同机 |
| HTTP 框架 | Fastify | 轻、快、内置 schema 校验 |
| WebSocket | `ws` / `@fastify/websocket` | 流式输出 |
| 鉴权 | bcrypt(密码 hash) + JWT(session) | 无状态、单账号够用 |
| 子进程 | `child_process.spawn` | 跑 `claude -p` |
| 前端 | 静态 HTML + JS + xterm.js | 输出渲染，手机友好 |
| 反代/TLS | Caddy（自动 HTTPS）或 Nginx + certbot | 公网 TLS |
| 进程托管 | systemd（或 pm2） | 开机自启、崩溃重启 |

---

## 5. 鉴权设计（单用户，公网）

1. **账号**：`ADMIN_USER` + `ADMIN_PASS_HASH`（bcrypt）放环境变量 / `.env`，**绝不入库不入 git**。无注册、无找回、无第三方登录。
2. **登录流程**：`POST /api/login {user,pass}` → bcrypt 比对 → 签发短期 JWT（如 12h）放 HttpOnly + Secure + SameSite=Strict cookie。
3. **会话校验**：所有 `/api` 和 WS 连接校验 JWT；失败 401。
4. **防爆破**：登录失败按 IP 限流（如 5 次/15 分钟锁定），上报日志。
5. **CSRF**：cookie 鉴权配合 SameSite=Strict + 对写操作校验 Origin。
6. **密钥**：JWT secret 为高熵随机值，存环境变量。

---

## 6. 工作目录（cwd）控制——安全核心

这是最危险的一环：能指定目录跑 `claude` ≈ 能在该目录执行任意命令。

1. **白名单根**：配置 `ALLOWED_ROOTS`（如 `/home/ec2-user/projects`）。用户只能选其下的子目录。
2. **路径规范化校验**：`path.resolve` 后必须 `startsWith` 某个 allowed root，且 `realpath` 解析软链后仍在根内（防 `../` 和符号链接逃逸）。
3. **目录发现**：提供 `GET /api/dirs?root=...` 列出白名单根下的子目录供选择，不接受任意手输路径直接执行——手输也走同一校验。
4. **以低权限用户运行**：后端进程用专用非 root 系统用户，CC 继承该权限；该用户对 allowed roots 之外无写权限。
5. （可选增强）用 `bubblewrap` / 容器把每次执行沙箱化。第一版至少做到 2+4。

---

## 7. API 设计

```
POST /api/login            {user, pass}            → set cookie
POST /api/logout
GET  /api/me                                        → 当前登录态
GET  /api/dirs?root=<path>                          → 白名单内子目录列表
GET  /api/sessions                                  → 本地记录的会话列表
POST /api/sessions         {cwd, title}             → 新建会话(生成 uuid)
DEL  /api/sessions/:id
WS   /ws/run                                         → 跑任务 + 流式输出
```

### WS 协议（/ws/run）
客户端发：
```json
{ "type": "run", "sessionId": "<uuid>", "cwd": "/abs/path", "prompt": "...", "resume": true }
{ "type": "cancel" }
```
服务端回（逐事件）：
```json
{ "type": "started", "pid": 1234 }
{ "type": "event", "data": { /* claude stream-json 原始事件 */ } }
{ "type": "stderr", "line": "..." }
{ "type": "done", "exitCode": 0, "sessionId": "<uuid>" }
{ "type": "error", "message": "..." }
```
- 一个 WS 连接同一时刻只允许一个运行中的子进程；cancel → `child.kill('SIGTERM')`，超时再 `SIGKILL`。
- `done` 回传 CC 实际用的 sessionId，前端据此更新续接 id。

---

## 8. 会话（session）管理

- 本地用一个轻量存储（JSON 文件或 SQLite）记录会话元数据：`{id, title, cwd, createdAt, lastRunAt}`。真正的对话上下文由 Claude Code 自己按 session-id 维护。
- 新建会话：前端生成/后端生成一个 uuid 作为 `--session-id`，首次 run 创建。
- 续接：`--resume <id>`。
- 切换：前端列表点选，后续 run 带上该 id。

---

## 8.5 Apps 功能（独立服务，与 core 进程隔离）

通过 CC 动态生成/部署网页，服务端自动路由 + 热加载，无需重启。**apps 服务是独立进程，崩溃不影响 core 控制台。**

### 进程隔离架构
```
┌─────────────────────────────────┐
│  core 后端 (Fastify) :PORT_CORE   │  登录/会话/跑 claude -p (永远稳定)
└──────────────┬──────────────────┘
               │ /apps/* 反向代理 (core→apps, 127.0.0.1)
               ▼
┌─────────────────────────────────┐
│  apps 服务 (独立进程) :PORT_APPS   │  只托管/热加载 apps/
│  ├─ chokidar 监听 apps/           │
│  ├─ 静态 app → 直接托管            │
│  └─ 动态 app → 各自独立子进程       │
└─────────────────────────────────┘
```
- **两个独立 systemd unit**：`cc-web-core.service` / `cc-web-apps.service`，互不依赖启动顺序。
- core 把 `/apps/*` 反代到 apps 服务；apps 宕机 → core 返回 503，控制台不受影响。
- apps 服务只绑 `127.0.0.1:PORT_APPS`，不对外暴露，一律经 core 代理。
- **资源隔离**：apps 服务用 systemd `MemoryMax=`/`CPUQuota=` 单独限额，CC 生成的失控代码困在这一侧。

### App 两种形态
| 形态 | 结构 | 托管方式 | 开关 |
|---|---|---|---|
| 静态 | `apps/<name>/index.html` + 资源 | apps 服务当静态目录挂 `/apps/<name>/` | 默认开 |
| 动态 | `apps/<name>/app.json` + `server.js` | apps 服务 spawn 独立子进程，内部反代 | `APPS_DYNAMIC_ENABLED`，默认关 |

- `app.json` 声明入口/端口/类型：`{ "name":"todo", "type":"static|dynamic", "entry":"server.js", "port":0 }`（port=0 由 apps 服务分配）。
- 动态 app 各跑一个子进程，单个崩溃只影响自己；apps 服务做 health check + 自动重启 + 失败熔断。

### 热加载
- `chokidar` 监听 `apps/` 目录：
  - 新增/改动目录 → 读 `app.json` → 静态 app 立即重建路由表（秒级）；动态 app 重启其子进程。
  - 删除目录 → 摘路由、kill 子进程。
- 维护一个内存 registry：`{ name → {type, status, pid?, mountPath} }`，core 可查 `/api/apps` 展示列表。

### CC 如何生成 app
- 前端有「Apps」页：新建 app → core 用 `claude -p`，cwd 设为 `apps/<name>/`，prompt 让 CC 生成页面（静态）或完整 `app.json`+`server.js`（动态）。
- 生成即落盘 → chokidar 感知 → 自动上线 `/apps/<name>/`。
- `apps/` 目录 gitignore（内容是运行时产物，不进仓库）。

### 安全
- 动态 app = 跑 CC 自动生成的任意代码，默认关闭；开启需显式 `APPS_DYNAMIC_ENABLED=true`。
- 动态子进程以受限用户 + 资源上限运行；apps 服务与 core 隔离，互不拖累。
- `/apps/*` 仍在 core 的登录鉴权之后（未登录访问不到）。

---

## 9. 目录结构

```
cc-web/
├─ DESIGN.md
├─ README.md
├─ .gitignore                # .env, apps/, node_modules, data/
├─ .env.example              # 所有配置项示例(无真实密钥)
├─ package.json              # npm workspaces: packages/*
├─ packages/
│  ├─ core/                  # 控制台后端 (稳定, 永不跑 app 代码)
│  │  ├─ src/
│  │  │  ├─ server.js        # Fastify 启动 + 路由注册
│  │  │  ├─ auth.js          # 登录、JWT、限流
│  │  │  ├─ originGuard.js   # 校验 CloudFront X-Origin-Secret
│  │  │  ├─ dirs.js          # 白名单 + 路径校验 + 列目录
│  │  │  ├─ sessions.js      # 会话元数据 CRUD
│  │  │  ├─ runner.js        # spawn claude -p + stream-json 解析
│  │  │  ├─ ws.js            # /ws/run 流式
│  │  │  └─ appsProxy.js     # /apps/* 反代到 apps 服务 + 503 兜底
│  │  └─ public/             # 控制台前端 (登录/会话/Apps 页)
│  │     ├─ index.html
│  │     ├─ app.js
│  │     └─ style.css
│  └─ apps/                  # 独立 apps 托管服务 (隔离进程)
│     └─ src/
│        ├─ server.js        # 绑 127.0.0.1:PORT_APPS
│        ├─ registry.js      # 内存 app 注册表
│        ├─ watcher.js       # chokidar 热加载
│        ├─ static.js        # 静态 app 托管
│        └─ dynamic.js       # 动态 app 子进程管理 + health
├─ apps/                     # CC 生成的 app 落盘处 (gitignored)
├─ data/                     # sessions.json 等运行时数据 (gitignored)
├─ scripts/
│  └─ hash-pass.js           # 生成 ADMIN_PASS_HASH
└─ deploy/
   ├─ install.sh             # EC2 一键安装 (依赖+用户+systemd+随机secret)
   ├─ cc-web-core.service    # core systemd unit
   ├─ cc-web-apps.service    # apps systemd unit (含 MemoryMax/CPUQuota)
   └─ cloudfront.md          # CloudFront 分发配置清单 (ACM/WS/header/缓存)
```

---

## 10. 部署（CloudFront + EC2 Linux）

### EC2 后端
1. **机器准备**：装 Node LTS、`claude` CLI 并完成一次登录鉴权（CC 凭证归 CC 管）。
2. **专用用户**：建 `ccweb` 系统用户跑后端，限制其对 allowed roots 以外的权限。
3. **监听**：后端监听 `0.0.0.0:<PORT>`（任意端口，HTTP 即可，TLS 由 CloudFront 终止）。
4. **systemd**：`cc-web.service` 开机自启、崩溃重启、环境变量从 `/etc/cc-web/env` 读。

### CloudFront 分发
5. **证书**：在 **us-east-1** 用 ACM 申请证书（CloudFront 只认 us-east-1 的 ACM），绑到分发 + 自定义域名；没域名可暂用默认的 `*.cloudfront.net`。
6. **Origin**：类型为 custom origin，指向 EC2 公网 DNS 的那个任意端口，协议按需 HTTP/HTTPS。
7. **WebSocket**：CloudFront 原生支持 WS，但 `/ws/*` 行为必须用 **Managed-AllViewer** origin request policy（转发全部 header/cookie/query）且缓存策略为 **CachingDisabled**，否则流式断。
8. **缓存策略**：
   - `/api/*`、`/ws/*`：`CachingDisabled` + 转发 `Authorization`/Cookie/Origin。
   - 静态资源（`/`, `/app.js`, `/style.css`）：可缓存。
9. **源站校验 header**：CloudFront 对所有回源请求注入一个自定义 header，如 `X-Origin-Secret: <高熵随机值>`（Origin custom headers）。后端对缺失/不匹配该 header 的请求直接 403——这样别人即使拿到 EC2 公网地址直连也进不来。

### 源站保护（关键，别漏）
10. **安全组**：EC2 安全组的那个端口 **只放行 CloudFront 源 IP**，用 AWS 托管前缀列表 `com.amazonaws.global.cloudfront.origin-facing`（在安全组规则里按 prefix list 引用），**不要** `0.0.0.0/0`。
11. **双保险**：源 IP 限制（第 10 条）+ 自定义 header 校验（第 9 条）一起上。只做其中一个都不够：prefix list 内是所有 CloudFront 用户共享的，header 才是你这个分发独有的凭证。

### 可选增强
12. CloudFront 前挂 **AWS WAF**（限速、地理封锁、常见攻击规则），对一个单用户站点性价比很高。
13. 或者用 **CloudFront + Lambda@Edge / CloudFront Functions** 做一层边缘登录（basic auth），在请求到 EC2 之前就挡掉未授权流量。

---

## 11. 安全清单（公网必做）

- [ ] TLS 由 CloudFront + ACM(us-east-1) 终止；EC2 不管证书。
- [ ] EC2 源站端口安全组只放行 CloudFront 前缀列表 `com.amazonaws.global.cloudfront.origin-facing`，**禁用** `0.0.0.0/0`。
- [ ] 后端校验 CloudFront 注入的 `X-Origin-Secret`，缺失/不匹配 → 403（防绕过 CloudFront 直连源站）。
- [ ] CloudFront `/api/*`、`/ws/*` 行为用 CachingDisabled + AllViewer，转发 Authorization/Cookie。
- [ ] JWT HttpOnly + Secure + SameSite=Strict；短有效期。
- [ ] 登录按 IP 限流 + 失败日志（取真实 IP 用 `X-Forwarded-For` 最右可信跳）。
- [ ] cwd 白名单 + realpath 逃逸校验。
- [ ] 后端跑在非 root 专用用户下。
- [ ] 所有请求/执行留审计日志（谁、何时、在哪个目录、跑了什么）。
- [ ] 机密只在环境变量，不进 git（`.env` 加 `.gitignore`）。
- [ ] （建议）CloudFront 前挂 WAF 限速 + 地理封锁。
- [ ] 速率限制并发执行数（防资源耗尽）。

---

## 12. 里程碑

- **M1 骨架**：Fastify 服务 + 登录 + JWT + 静态前端 + 健康检查。
- **M2 执行核心**：`runner.js` 跑 `claude -p --output-format stream-json`，WS 流式回前端。
- **M3 目录与会话**：白名单目录选择 + 会话列表 + 续接。
- **M4 部署加固**：systemd + CloudFront 分发 + 源站校验/安全组 + 安全清单落实，EC2 实测。

---

## 13. 待确认 / 风险

1. 目标 EC2 上 `claude` 的版本与 `-p` / `stream-json` / `--session-id` 的确切 flag——编码前先在机器上 `claude --help` 探测。
2. 自定义域名还是先用默认 `*.cloudfront.net`？域名决定 ACM 证书与 CNAME 配置。
3. `ALLOWED_ROOTS` 具体路径（CC 允许运行的目录根）。
4. WS 经 CloudFront 的空闲超时（默认连接超时较短）需确认，长任务要考虑心跳保活。
5. 是否加 WAF / 边缘 basic auth 作为额外防线（建议至少 WAF 限速）。
