import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isHot } from './config.js';
import {
  adminEnabled,
  checkAdminToken,
  clearAdminCookie,
  isAdmin,
  loginLimiter,
  registerRateLimit,
  registerSecurityHeaders,
  requireAdmin,
  sameOrigin,
  setAdminCookie,
} from './http/security.js';
import { hub, simStatus } from './http/stream.js';
import { logger } from './lib/log.js';
import { allPollerStatus, stopAllPollers } from './lib/poller.js';
import { simulator } from './sim/simulator.js';
import { startBallot } from './sources/ballot.js';
import { startCnn } from './sources/cnn.js';
import { startNews } from './sources/news.js';
import { startNyt } from './sources/nyt.js';
import { startPolymarket } from './sources/polymarket.js';
import { startWikipedia } from './sources/wikipedia.js';
import { countyStore } from './store/counties.js';
import { stateRaceStore } from './store/stateRaces.js';
import { STATE_BY_POSTAL } from '../../shared/src/states.js';
import { measureStore } from './store/measures.js';
import { loadState, saveState, startAutosave } from './store/persist.js';
import { store } from './store/store.js';

const log = logger('server');

function trustProxySetting(): boolean | string | ((addr: string, hop: number) => boolean) | undefined {
  const v = config.security.trustProxy.trim();
  if (!v) return undefined;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr: string, hop: number) => hop < hops;
  }
  return v;
}

const app = Fastify({
  logger: false,
  bodyLimit: 16 * 1024,
  trustProxy: trustProxySetting(),
  // Generous but finite timeouts; the SSE route is hijacked and unaffected.
  connectionTimeout: 0,
  keepAliveTimeout: 72_000,
});

registerSecurityHeaders(app);
registerRateLimit(app);
await app.register(compress, { global: true, customTypes: /^(application\/json|text\/|application\/javascript|image\/svg)/ });

// ------------------------------------------------------------------ live stream

hub.register(app);

// Poll-closing status is time-based; recompute every 30s even if no data changed.
setInterval(() => {
  store.scheduleRecompute();
  measureStore.schedule();
}, 30_000).unref();

// ------------------------------------------------------------------ public REST (read-only)

const publicSnapshot = () => ({ ...store.snapshot(), sim: simStatus(false) });

app.get('/api/state', async () => publicSnapshot());
app.get('/api/measures', async () => [...store.measures.values()]);
/** County-level results for one race (drill-down). Admins viewing the simulation get sim counties. */
app.get('/api/races/:id/counties', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!store.races.has(id)) return reply.code(404).send({ error: 'not found' });
  const live = countyStore.get(id);
  if (!live) return { raceId: id, updatedAt: null, source: 'none', units: [] };
  if ((req.query as { view?: string }).view === 'sim' && simulator.running && isAdmin(req)) {
    const sim = simulator.countiesFor(id, live);
    if (sim) return sim;
  }
  return live;
});
// Statewide view: every race in a state's NYT/AP file, and one county's slice of it.
app.get('/api/states/:st', async (req, reply) => {
  const st = (req.params as { st: string }).st.toUpperCase();
  if (!STATE_BY_POSTAL[st]) return reply.code(404).send({ error: 'unknown state' });
  return stateRaceStore.summary(st);
});
app.get('/api/states/:st/races/:id/counties', async (req, reply) => {
  const { st, id } = req.params as { st: string; id: string };
  const units = stateRaceStore.raceCounties(st.toUpperCase(), id);
  if (!units) return reply.code(404).send({ error: 'no county results for this race' });
  return { raceId: id, units };
});
app.get('/api/states/:st/counties/:fips', async (req, reply) => {
  const { st, fips } = req.params as { st: string; fips: string };
  const c = /^\d{5}$/.test(fips) ? stateRaceStore.county(st.toUpperCase(), fips) : null;
  if (!c) return reply.code(404).send({ error: 'unknown county' });
  return c;
});
app.get('/api/races/:id', async (req, reply) => {
  const r = store.races.get((req.params as { id: string }).id);
  return r ?? reply.code(404).send({ error: 'not found' });
});
/** Minimal public health for container checks; details are admin-only. */
app.get('/api/health', async (req) =>
  isAdmin(req) ? { ok: true, hot: isHot(), clients: hub.clients.size, races: store.races.size, sources: allPollerStatus() } : { ok: true },
);

// ------------------------------------------------------------------ admin

app.get('/api/admin/me', async (req) => ({ admin: isAdmin(req), adminEnabled: adminEnabled(), sim: simStatus(isAdmin(req)) }));

app.post('/api/admin/login', async (req, reply) => {
  if (!adminEnabled()) return reply.code(404).send({ error: 'Admin features are disabled (set ADMIN_TOKEN)' });
  if (!sameOrigin(req)) return reply.code(403).send({ error: 'Cross-origin request blocked' });
  if (!loginLimiter.take(req.ip)) {
    reply.header('Retry-After', '900');
    return reply.code(429).send({ error: 'Too many attempts; try again later' });
  }
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (!checkAdminToken(token)) {
    log.warn(`failed admin sign-in from ${req.ip}`);
    return reply.code(401).send({ error: 'Invalid token' });
  }
  setAdminCookie(req, reply);
  log.info(`admin signed in from ${req.ip}`);
  return { admin: true };
});

app.post('/api/admin/logout', async (req, reply) => {
  if (!sameOrigin(req)) return reply.code(403).send({ error: 'Cross-origin request blocked' });
  clearAdminCookie(reply);
  return { admin: false };
});

// Simulator control — admin session + same-origin + custom header + JSON required.
const simGuard = async (req: Parameters<typeof requireAdmin>[0], reply: Parameters<typeof requireAdmin>[1]) => {
  await requireAdmin(req, reply);
  if (reply.sent) return;
  if (!config.sim.allowed) return reply.code(403).send({ error: 'Simulator disabled (SIM_ALLOWED=false)' });
};

app.post('/api/admin/sim/start', { preHandler: simGuard }, async (req, reply) => {
  const body = (req.body ?? {}) as { speed?: number };
  try {
    simulator.start(Number(body.speed) || config.sim.speed);
    return simStatus(true);
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
});
app.post('/api/admin/sim/stop', { preHandler: simGuard }, async () => {
  simulator.stop();
  return simStatus(true);
});
app.post('/api/admin/sim/pause', { preHandler: simGuard }, async (req, reply) => {
  const body = (req.body ?? {}) as { paused?: boolean };
  if (!simulator.running) return reply.code(409).send({ error: 'not running' });
  simulator.setPaused(body.paused !== false);
  return simStatus(true);
});
app.post('/api/admin/sim/speed', { preHandler: simGuard }, async (req, reply) => {
  const body = (req.body ?? {}) as { speed?: number };
  if (!simulator.running) return reply.code(409).send({ error: 'not running' });
  simulator.setSpeed(Number(body.speed) || simulator.speed);
  return simStatus(true);
});

// ------------------------------------------------------------------ static web app

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, config.webDist);
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    wildcard: false,
    cacheControl: false,
    // Hashed assets are immutable; geometry changes rarely; HTML must revalidate.
    // @fastify/static v10 passes the Fastify reply (not the raw response).
    setHeaders: (reply: { header: (k: string, v: string) => unknown }, filePath: string) => {
      const p = filePath.replace(/\\/g, '/');
      if (p.includes('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (p.includes('/geo/') || p.includes('/baselines/')) reply.header('Cache-Control', 'public, max-age=86400');
      else reply.header('Cache-Control', 'no-cache');
    },
  });
  // SPA fallback: any non-API route serves index.html (client-side routing).
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    return (reply.header('Cache-Control', 'no-cache') as unknown as { sendFile: (f: string) => unknown }).sendFile('index.html');
  });
  log.info(`serving web app from ${webDist}`);
} else {
  log.warn(`web build not found at ${webDist}; API only (run the Vite dev server for the UI)`);
}

// ------------------------------------------------------------------ boot

await loadState();
startNyt();
startCnn();
startWikipedia();
startPolymarket();
startNews();
startBallot();
startAutosave();

if (!adminEnabled()) log.warn('ADMIN_TOKEN not set (or shorter than 16 chars): admin sign-in and the simulator are disabled');

const shutdown = async (sig: string) => {
  log.info(`${sig} received, saving state`);
  stopAllPollers();
  simulator.stop();
  await saveState();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
log.info(`listening on http://${config.host}:${config.port} (hot window: ${isHot()}, trustProxy: ${config.security.trustProxy || 'off'})`);
