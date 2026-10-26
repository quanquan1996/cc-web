// WS /ws/run — run a prompt and stream claude's stream-json events.
//
// client -> server: {type:'run', sessionId, cwd, prompt, resume} | {type:'cancel'}
// server -> client: {type:'started', pid} | {type:'event', data} | {type:'stderr', line}
//                   {type:'done', exitCode, sessionId} | {type:'error', message}
import { verifyAuth, originAllowed, clientIp } from './auth.js';
import { run } from './runner.js';
import { getSession, updateSession } from './sessions.js';
import { audit } from './audit.js';

const PING_MS = 20_000; // keeps CloudFront's idle timer from closing the socket

export function registerWs(app) {
  app.get(
    '/ws/run',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(req.headers)) return reply.code(403).send({ error: 'bad origin' });
        return verifyAuth(req, reply);
      },
    },
    (socket, req) => {
      const ip = clientIp(req);
      let current = null; // one running child per socket

      const send = (msg) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(msg));
      };

      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const pinger = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        try {
          socket.ping();
        } catch {
          /* socket already closing */
        }
      }, PING_MS);

      async function startRun(msg) {
        if (current) return send({ type: 'error', message: 'a run is already in progress on this connection' });
        const session = await getSession(msg.sessionId);
        if (!session) return send({ type: 'error', message: 'unknown session; create it first' });

        const cwd = typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : session.cwd;
        // First run creates the Claude session (--session-id), later runs --resume it.
        const resume = typeof msg.resume === 'boolean' ? msg.resume : Boolean(session.lastRunAt);
        const claudeId = session.claudeSessionId || session.id;

        let r;
        try {
          r = await run(msg.prompt, { cwd, sessionId: claudeId, resume });
        } catch (err) {
          return send({ type: 'error', message: err.message });
        }
        current = r;
        let finished = false;
        audit('run_start', { ip, sessionId: session.id, cwd, resume, pid: r.pid, prompt: msg.prompt.slice(0, 2000) });
        req.log.info({ sessionId: session.id, cwd, pid: r.pid }, 'run started');
        send({ type: 'started', pid: r.pid });
        updateSession(session.id, { lastRunAt: new Date().toISOString() }).catch(() => {});

        r.on('event', (data) => send({ type: 'event', data }));
        r.on('stdout', (line) => send({ type: 'stderr', line }));
        r.on('stderr', (line) => send({ type: 'stderr', line }));
        r.on('error', (err) => {
          if (finished) return;
          finished = true;
          current = null;
          audit('run_error', { ip, sessionId: session.id, error: err.message });
          send({ type: 'error', message: `failed to start claude: ${err.message}` });
        });
        r.on('exit', async ({ exitCode, sessionId }) => {
          if (finished) return;
          finished = true;
          current = null;
          if (sessionId && sessionId !== claudeId) {
            await updateSession(session.id, { claudeSessionId: sessionId }).catch(() => {});
          }
          audit('run_done', { ip, sessionId: session.id, exitCode });
          send({ type: 'done', exitCode, sessionId });
        });
      }

      socket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send({ type: 'error', message: 'invalid JSON' });
        }
        if (msg?.type === 'run') {
          startRun(msg).catch((err) => send({ type: 'error', message: err.message }));
        } else if (msg?.type === 'cancel') {
          if (current) {
            audit('run_cancel', { ip, pid: current.pid });
            current.cancel();
          }
        } else {
          send({ type: 'error', message: 'unknown message type' });
        }
      });

      socket.on('close', () => {
        clearInterval(pinger);
        current?.cancel();
        current = null;
      });
      socket.on('error', () => {});
    },
  );
}
