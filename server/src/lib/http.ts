import { config } from '../config.js';

export class HttpError extends Error {
  constructor(public status: number, public url: string, public retryAfterMs?: number) {
    super(`HTTP ${status} for ${url}`);
  }
}

interface CacheEntry {
  etag?: string;
  lastModified?: string;
}

/** Remembers validators per URL so polling uses conditional GETs (cheap 304s on the CDN). */
const validators = new Map<string, CacheEntry>();

export interface FetchResult<T> {
  /** false when the server answered 304 Not Modified. */
  changed: boolean;
  data?: T;
  status: number;
}

interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  conditional?: boolean;
  headers?: Record<string, string>;
  accept?: string;
}

async function doFetch(url: string, opts: FetchOpts): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: opts.accept ?? 'application/json',
    ...opts.headers,
  };
  if (opts.conditional) {
    const v = validators.get(url);
    if (v?.etag) headers['If-None-Match'] = v.etag;
    if (v?.lastModified) headers['If-Modified-Since'] = v.lastModified;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (res.status === 304) return res;
  if (!res.ok) {
    const ra = res.headers.get('retry-after');
    const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Date.parse(ra) - Date.now()) : undefined;
    throw new HttpError(res.status, url, retryAfterMs);
  }
  if (opts.conditional) {
    validators.set(url, {
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    });
  }
  return res;
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<FetchResult<T>> {
  const res = await doFetch(url, opts);
  if (res.status === 304) return { changed: false, status: 304 };
  return { changed: true, data: (await res.json()) as T, status: res.status };
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<FetchResult<string>> {
  const res = await doFetch(url, { accept: '*/*', ...opts });
  if (res.status === 304) return { changed: false, status: 304 };
  return { changed: true, data: await res.text(), status: res.status };
}

/** Forget cached validators (forces a full refetch next time). */
export function resetValidators(prefix?: string) {
  for (const k of validators.keys()) if (!prefix || k.startsWith(prefix)) validators.delete(k);
}
