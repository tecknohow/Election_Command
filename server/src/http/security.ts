import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../lib/log.js';

const log = logger('security');
const COOKIE = 'ec_admin';

export const adminEnabled = () => config.security.adminToken.length >= 16;

// ------------------------------------------------------------------ security headers

/**
 * Strict CSP: only our own scripts/styles/connections; images also from NYT's CDN (candidate
 * headshots). Inline style *attributes* are needed for data-driven colors (React style={}).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://static01.nyt.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (config.security.hsts && req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

// ------------------------------------------------------------------ rate limiting

interface Bucket {
  tokens: number;
  updated: number;
}

/** Simple per-key token bucket; `perWindow` tokens refill continuously over `windowMs`. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private perWindow: number,
    private windowMs: number,
  ) {
    setInterval(() => this.sweep(), 5 * 60_000).unref();
  }

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perWindow, updated: now };
    b.tokens = Math.min(this.perWindow, b.tokens + ((now - b.updated) / this.windowMs) * this.perWindow);
    b.updated = now;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    return ok;
  }

  private sweep() {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [k, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(k);
  }
}

const apiLimiter = new RateLimiter(config.security.apiRatePerMin, 60_000);
export const loginLimiter = new RateLimiter(config.security.loginAttempts, 15 * 60_000);

/** Rate-limit REST API calls per client IP (the live stream and static files are exempt). */
export function registerRateLimit(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/stream') || req.url === '/api/health') return;
    if (!apiLimiter.take(req.ip)) {
      reply.header('Retry-After', '30');
      return reply.code(429).send({ error: 'Too many requests' });
    }
  });
}

// ------------------------------------------------------------------ admin sessions

function sessionKey() {
  // Derived from the admin token: sessions survive restarts and are revoked by changing the token.
  return createHmac('sha256', config.security.adminToken).update('ec-admin-session-v1').digest();
}

function sign(payload: string) {
  return createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkAdminToken(candidate: unknown): boolean {
  if (!adminEnabled() || typeof candidate !== 'string') return false;
  // Compare HMACs so the comparison is constant-time regardless of input length.
  const k = 'ec-token-compare';
  return safeEqual(createHmac('sha256', k).update(candidate).digest('hex'), createHmac('sha256', k).update(config.security.adminToken).digest('hex'));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAdmin(req: FastifyRequest): boolean {
  if (!adminEnabled()) return false;
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

export function setAdminCookie(req: FastifyRequest, reply: FastifyReply) {
  const exp = String(Date.now() + config.security.sessionDays * 86_400_000);
  const secure = req.protocol === 'https' ? '; Secure' : '';
  reply.header('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.security.sessionDays * 86_400}${secure}`);
}

export function clearAdminCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/**
 * Guard for state-changing admin routes: valid session + same-origin request + the custom
 * header our client sends (forces a CORS preflight for any cross-site attempt, which we never
 * approve) + JSON body. SameSite=Strict on the cookie is a further layer.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!sameOrigin(req)) {
    log.warn(`blocked cross-origin admin request from ${req.ip} (${req.headers.origin ?? req.headers['sec-fetch-site']})`);
    return reply.code(403).send({ error: 'Cross-origin request blocked' });
  }
  if (!isAdmin(req)) return reply.code(401).send({ error: 'Admin sign-in required' });
}

export function sameOrigin(req: FastifyRequest): boolean {
  if (req.headers['x-ec-request'] !== '1') return false;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = (req.headers['x-forwarded-host'] as string | undefined) && config.security.trustProxy ? String(req.headers['x-forwarded-host']) : req.headers.host;
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
