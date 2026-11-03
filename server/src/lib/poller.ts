import type { SourceStatus } from '../../../shared/src/types.js';
import { isHot } from '../config.js';
import { HttpError } from './http.js';
import { logger } from './log.js';

export interface PollerOptions {
  id: string;
  name: string;
  role: string;
  /** Seconds between runs during the election-night hot window. */
  hotIntervalS: number;
  /** Seconds between runs outside the hot window. */
  coldIntervalS: number;
  enabled?: boolean;
  /** Max backoff when the upstream is failing. */
  maxBackoffS?: number;
  /** Delay the first run (to stagger sources). */
  initialDelayMs?: number;
  /**
   * The task. Return `false` if the upstream reported "not modified", or a string to
   * use as the status detail line.
   */
  run: () => Promise<boolean | string | void>;
}

const pollers: Poller[] = [];

/**
 * A single upstream polling loop with:
 *  - adaptive cadence (hot/cold window),
 *  - +/-10% jitter so several sources don't fire in lockstep,
 *  - exponential backoff on failures (honouring Retry-After / 429),
 *  - status bookkeeping surfaced to the UI's source-health panel.
 */
export class Poller {
  status: SourceStatus;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private log;

  constructor(private opts: PollerOptions) {
    this.log = logger(opts.id);
    this.status = {
      id: opts.id,
      name: opts.name,
      role: opts.role,
      ok: false,
      enabled: opts.enabled ?? true,
      lastSuccess: null,
      lastAttempt: null,
      lastError: null,
      intervalMs: this.baseInterval(),
      lastDurationMs: null,
      failures: 0,
      notModified: 0,
      requests: 0,
    };
    pollers.push(this);
  }

  private baseInterval() {
    return (isHot() ? this.opts.hotIntervalS : this.opts.coldIntervalS) * 1000;
  }

  start() {
    if (!this.status.enabled) {
      this.status.detail = 'disabled by configuration';
      return;
    }
    this.schedule(this.opts.initialDelayMs ?? 0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run immediately (used for manual refresh); ignored if a run is in flight. */
  async trigger() {
    if (this.running) return;
    this.stop();
    await this.tick();
  }

  private schedule(ms: number) {
    this.stop();
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    this.status.lastAttempt = new Date().toISOString();
    this.status.requests++;
    let nextMs = this.baseInterval();
    try {
      const r = await this.opts.run();
      this.status.ok = true;
      this.status.failures = 0;
      this.status.lastError = null;
      this.status.lastSuccess = new Date().toISOString();
      if (r === false) this.status.notModified++;
      if (typeof r === 'string') this.status.detail = r;
    } catch (err) {
      this.status.failures++;
      this.status.ok = false;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      const backoff = Math.min(nextMs * 2 ** this.status.failures, (this.opts.maxBackoffS ?? 600) * 1000);
      nextMs = backoff;
      if (err instanceof HttpError && err.retryAfterMs && err.retryAfterMs > 0) {
        nextMs = Math.max(nextMs, err.retryAfterMs);
      }
      this.log.warn(`run failed (${this.status.failures}x), retry in ${Math.round(nextMs / 1000)}s: ${this.status.lastError}`);
    } finally {
      this.status.lastDurationMs = Date.now() - t0;
      this.status.intervalMs = this.baseInterval();
      this.running = false;
      const jitter = 1 + (Math.random() * 0.2 - 0.1);
      this.schedule(Math.round(nextMs * jitter));
    }
  }
}

export function allPollerStatus(): SourceStatus[] {
  return pollers.map((p) => ({ ...p.status }));
}

export function stopAllPollers() {
  pollers.forEach((p) => p.stop());
}
