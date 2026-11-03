/**
 * Runtime configuration. Every knob is overridable via environment variables so the
 * Docker deployment can be tuned without a rebuild.
 */
const env = process.env;

const num = (key: string, dflt: number) => {
  const v = env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
const bool = (key: string, dflt: boolean) => {
  const v = env[key];
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const config = {
  port: num('PORT', 8080),
  host: env.HOST ?? '0.0.0.0',
  dataDir: env.DATA_DIR ?? './data',
  webDist: env.WEB_DIST ?? '../../web/dist',
  electionDate: env.ELECTION_DATE ?? '2026-11-03',
  userAgent: env.USER_AGENT ?? 'ElectionCommand/0.1 (personal election-night dashboard)',

  /**
   * "Hot" window: aggressive polling while results are actually flowing.
   * Outside of it every poller backs off to its cold interval to be a good citizen.
   */
  hotStart: env.HOT_START ?? '2026-11-03T20:00:00Z', // 3pm ET
  hotEnd: env.HOT_END ?? '2026-11-05T12:00:00Z',

  intervals: {
    nyt: { hot: num('NYT_INTERVAL_S', 20), cold: 300 },
    nytHouse: { hot: num('NYT_HOUSE_INTERVAL_S', 45), cold: 600 },
    nytCounties: { hot: num('NYT_COUNTY_INTERVAL_S', 45), cold: 900 },
    cnn: { hot: num('CNN_INTERVAL_S', 30), cold: 300 },
    polymarketPrices: { hot: num('POLYMARKET_INTERVAL_S', 30), cold: 120 },
    polymarketDiscovery: { hot: 1800, cold: 3600 },
    wikipedia: { hot: num('WIKIPEDIA_INTERVAL_S', 1800), cold: 3600 },
    news: { hot: num('NEWS_INTERVAL_S', 90), cold: 300 },
  },

  /** Results from the primary source older than this fall back to the secondary source. */
  staleAfterMs: num('STALE_AFTER_S', 180) * 1000,

  sources: {
    nyt: bool('ENABLE_NYT', true),
    cnn: bool('ENABLE_CNN', true),
    polymarket: bool('ENABLE_POLYMARKET', true),
    wikipedia: bool('ENABLE_WIKIPEDIA', true),
    news: bool('ENABLE_NEWS', true),
  },

  sim: {
    /** Allow the (admin-only) simulator. Also requires ADMIN_TOKEN. */
    allowed: bool('SIM_ALLOWED', true),
    speed: num('SIM_SPEED', 60),
  },

  security: {
    /**
     * Admin sign-in secret. Unset = no admin features at all (simulator disabled).
     * Generate with: openssl rand -hex 24
     */
    adminToken: env.ADMIN_TOKEN ?? '',
    /** Admin session lifetime. */
    sessionDays: num('ADMIN_SESSION_DAYS', 7),
    /**
     * Fastify trustProxy: set when running behind a reverse proxy (Caddy, nginx, Cloudflare)
     * so client IPs (rate limits) and https detection come from X-Forwarded-* headers.
     * "true", a hop count, or a comma-separated list of proxy IPs/CIDRs.
     */
    trustProxy: env.TRUST_PROXY ?? '',
    /** Send Strict-Transport-Security (only when served over HTTPS). */
    hsts: bool('HSTS', false),
    /** Live-stream connection caps. */
    maxStreams: num('MAX_STREAMS', 150),
    maxStreamsPerIp: num('MAX_STREAMS_PER_IP', 16),
    /** REST requests per IP per minute (static files and the stream are not counted). */
    apiRatePerMin: num('API_RATE_PER_MIN', 120),
    /** Admin sign-in attempts per IP per 15 minutes. */
    loginAttempts: num('LOGIN_ATTEMPTS_PER_15M', 8),
  },
};

export function isHot(now = Date.now()): boolean {
  return now >= Date.parse(config.hotStart) && now <= Date.parse(config.hotEnd);
}

export const NYT_BASE = `https://static01.nyt.com/elections-assets/pages/data/${config.electionDate}`;
export const CNN_BASE = 'https://politics.api.cnn.io/results/national-races';
