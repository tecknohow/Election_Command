import type { FastifyInstance } from 'fastify';
import zlib from 'node:zlib';
import type { SimStatus, StreamEvent } from '../../../shared/src/types.js';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { simulator } from '../sim/simulator.js';
import { type ElectionStore, store } from '../store/store.js';
import { adminEnabled, isAdmin } from './security.js';

const log = logger('stream');

type View = 'live' | 'sim';

interface Client {
  id: number;
  ip: string;
  admin: boolean;
  /** Admin opted into viewing the simulation (only effective while it runs). */
  wantsSim: boolean;
  write: (chunk: string) => void;
  close: () => void;
}

const PUBLIC_SIM: SimStatus = { enabled: false, allowed: false, running: false, paused: false, speed: 0, simTime: null };

export function simStatus(admin: boolean): SimStatus {
  if (!admin) return PUBLIC_SIM;
  const allowed = adminEnabled() && config.sim.allowed;
  return {
    enabled: allowed,
    allowed,
    running: simulator.running,
    paused: simulator.running && simulator.paused,
    speed: simulator.speed,
    simTime: simulator.running ? new Date(simulator.now()).toISOString() : null,
  };
}

const frame = (ev: StreamEvent) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

/** Snapshot/meta events carry simulator status, which is admin-only. */
function scrub(ev: StreamEvent, admin: boolean): StreamEvent {
  if (ev.type === 'snapshot') return { ...ev, data: { ...ev.data, sim: simStatus(admin) } };
  if (ev.type === 'meta') return { ...ev, data: { ...ev.data, sim: simStatus(admin) } };
  return ev;
}

/**
 * Fans store events out to connected browsers. Every client receives the LIVE store unless it
 * is an admin that opted into the simulation, in which case it receives the isolated sim
 * store. Streams are gzip-compressed (Z_SYNC_FLUSH per event) when the browser accepts it.
 */
class StreamHub {
  clients = new Set<Client>();
  private nextId = 1;

  viewOf(c: Client): View {
    return c.wantsSim && c.admin && simulator.running ? 'sim' : 'live';
  }

  storeFor(view: View): ElectionStore {
    return view === 'sim' && simulator.simStore ? simulator.simStore : store;
  }

  attach(source: ElectionStore, view: View) {
    source.on('event', (ev: StreamEvent) => this.broadcast(view, ev));
  }

  broadcast(view: View, ev: StreamEvent) {
    // Source health is global; everything else goes only to clients on that view.
    const global = ev.type === 'sources';
    const needsScrub = ev.type === 'snapshot' || ev.type === 'meta';
    let pub: string | undefined;
    let adm: string | undefined;
    for (const c of this.clients) {
      if (!global && this.viewOf(c) !== view) continue;
      if (needsScrub) c.write(c.admin ? (adm ??= frame(scrub(ev, true))) : (pub ??= frame(scrub(ev, false))));
      else c.write((pub ??= frame(ev)));
    }
  }

  sendSnapshot(c: Client) {
    const s = this.storeFor(this.viewOf(c));
    c.write(frame(scrub({ type: 'snapshot', data: s.snapshot() }, c.admin)));
  }

  /** Re-point admin viewers when a simulation starts or ends, and update their sim status. */
  onSimChange() {
    for (const c of this.clients) {
      if (!c.admin) continue;
      if (c.wantsSim) this.sendSnapshot(c);
      else c.write(frame(scrub({ type: 'meta', version: store.version, data: { mode: 'live', sim: PUBLIC_SIM, pollClosings: store.pollClosings() } }, true)));
    }
  }

  countFor(ip: string) {
    let n = 0;
    for (const c of this.clients) if (c.ip === ip) n++;
    return n;
  }

  register(app: FastifyInstance) {
    app.get('/api/stream', (req, reply) => {
      const ip = req.ip;
      if (this.clients.size >= config.security.maxStreams || this.countFor(ip) >= config.security.maxStreamsPerIp) {
        log.warn(`refused stream from ${ip}: connection cap reached`);
        reply.header('Retry-After', '15');
        return reply.code(429).send({ error: 'Too many live connections' });
      }
      const admin = isAdmin(req);
      const wantsSim = admin && (req.query as { view?: string }).view === 'sim';
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      });

      let write: (s: string) => void;
      let end: () => void;
      if (gzip) {
        const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH, level: 6 });
        gz.pipe(res);
        write = (s) => {
          if (!gz.destroyed) gz.write(s);
        };
        end = () => gz.end();
      } else {
        write = (s) => {
          if (!res.destroyed) res.write(s);
        };
        end = () => res.end();
      }

      const client: Client = { id: this.nextId++, ip, admin, wantsSim, write, close: end };
      this.clients.add(client);
      write('retry: 3000\n\n');
      this.sendSnapshot(client);
      log.info(`client ${client.id} connected from ${ip}${admin ? ' (admin)' : ''}${wantsSim ? ' [sim view]' : ''} — ${this.clients.size} open`);

      req.raw.on('close', () => {
        this.clients.delete(client);
        end();
        log.info(`client ${client.id} disconnected — ${this.clients.size} open`);
      });
    });

    // Heartbeat keeps proxies from idling out connections; sources double as a liveness tick.
    setInterval(() => {
      for (const c of this.clients) c.write(`: hb\n\n`);
      store.broadcastSources();
    }, 15_000).unref();
  }
}

export const hub = new StreamHub();

hub.attach(store, 'live');
simulator.on('session', (simStore: ElectionStore) => {
  hub.attach(simStore, 'sim');
  hub.onSimChange();
});
simulator.on('ended', () => hub.onSimChange());
