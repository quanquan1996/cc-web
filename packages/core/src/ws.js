// WS /ws/run — push channel for job output. Jobs are started and cancelled
// over HTTP (see jobs.js); this socket only streams their events, so closing
// it (tab closed, network lost) never affects a running job. Clients fall back
// to GET /api/jobs/:id/events long-polling when the socket is unavailable.
//
// client -> server: {type:'subscribe', jobId, cursor} | {type:'unsubscribe'}
// server -> client: {type:'events', jobId, job, from, cursor, events, more}
//                   {type:'error', jobId?, message}
import { verifyAuth, originAllowed } from './auth.js';
import { getJob, collect, MAX_WAIT_MS } from './jobs.js';

const PING_MS = 20_000; // keeps CloudFront's idle timer from closing the socket
const MAX_BUFFERED = 1024 * 1024; // don't pile up output on a stalled connection

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
    (socket) => {
      let sub = null; // one followed job per socket

      const open = () => socket.readyState === 1;
      const send = (msg) => {
        if (open()) socket.send(JSON.stringify(msg));
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

      const stop = () => {
        sub?.ac.abort();
        sub = null;
      };

      async function follow(s, job) {
        let cursor = s.cursor;
        let first = true;
        while (sub === s && open()) {
          while (socket.bufferedAmount > MAX_BUFFERED && sub === s && open()) {
            await new Promise((r) => setTimeout(r, 200));
          }
          const batch = await collect(job, cursor, first ? 0 : MAX_WAIT_MS, s.ac.signal);
          if (sub !== s) return;
          // Sent even when empty: the first one tells the client the status at
          // once, later ones double as a heartbeat (at least one per MAX_WAIT_MS).
          send({ type: 'events', jobId: job.id, ...batch });
          first = false;
          cursor = batch.cursor;
          if (batch.job.status !== 'running' && !batch.more) return;
        }
      }

      socket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send({ type: 'error', message: 'invalid JSON' });
        }
        if (msg?.type === 'subscribe') {
          stop();
          const job = typeof msg.jobId === 'string' ? getJob(msg.jobId) : null;
          if (!job) return send({ type: 'error', jobId: msg.jobId, message: 'unknown job' });
          const s = { ac: new AbortController(), cursor: Math.max(0, Number.parseInt(msg.cursor, 10) || 0) };
          sub = s;
          follow(s, job).catch((err) => send({ type: 'error', jobId: job.id, message: err.message }));
        } else if (msg?.type === 'unsubscribe') {
          stop();
        } else {
          send({ type: 'error', message: 'unknown message type' });
        }
      });

      socket.on('close', () => {
        clearInterval(pinger);
        stop(); // only stops pushing; the job keeps running
      });
      socket.on('error', () => {});
    },
  );
}
