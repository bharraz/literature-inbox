/**
 * Minimal HTTP layer shared by the scholarly clients.
 *
 * Requests go through a `Transport` so tests replay recorded fixtures and
 * never touch the network. The plugin supplies an implementation backed by
 * Obsidian's `requestUrl` — **not** `fetch`: `requestUrl` bypasses CORS,
 * works identically on desktop and mobile, and is the documented way for a
 * community plugin to make network calls.
 *
 * Retries on 429/5xx with exponential backoff, and enforces a minimum
 * interval between requests, so a run over hundreds of works stays a good
 * citizen of APIs that ask for no key at all.
 */

export const USER_AGENT = "literature-inbox/0.1 (Obsidian plugin)";

export class FetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FetchError";
  }
}

/** The resource does not exist. Separate from FetchError because callers
 * routinely want "not found" to mean `undefined`, not a failure. */
export class NotFoundError extends FetchError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export interface TransportResponse {
  status: number;
  text: string;
  /** `Retry-After` header, when the server sent one. Seconds, or an HTTP date. */
  retryAfter?: string;
}

/** A 429 that the caller should treat as "stop asking", not "try the next
 * thing" — see `RateLimitError` handling in the clients. */
export class RateLimitError extends FetchError {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

/**
 * A 429 that is not rate limiting at all.
 *
 * OpenAlex answers a request for a paid-plan feature with status 429 and a
 * body saying "Plan upgrade required". Retrying and backing off is exactly the
 * wrong response — waiting will never help — and reporting it as "we are going
 * too fast" sends the user off tuning something irrelevant. Cost a real
 * afternoon once; worth its own type.
 */
export class PlanRequiredError extends FetchError {
  constructor(message: string) {
    super(message, 429);
    this.name = "PlanRequiredError";
  }
}

/** Does a 429 body say this needs a paid plan rather than patience? */
export function isPlanRequired(body: string): boolean {
  return /plan upgrade required|requires a premium/i.test(body);
}

/** Seconds, or an HTTP date, into milliseconds to wait. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface Transport {
  get(url: string): Promise<TransportResponse>;
}

export interface RetryOptions {
  maxRetries?: number;
  backoffSeconds?: number;
  /** Injected so tests don't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET with retry/backoff. Throws NotFoundError on 404 (never retried — it
 * won't become found), FetchError on any other non-2xx once retries are spent.
 */
export async function getWithRetry(
  transport: Transport,
  url: string,
  options: RetryOptions = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? 3;
  const backoffSeconds = options.backoffSeconds ?? 1;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: FetchError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: TransportResponse;
    try {
      response = await transport.get(url);
    } catch (error) {
      // A thrown transport error (DNS failure, offline, ...) is retryable —
      // "no update this run" is the correct outcome, never a crash.
      lastError = new FetchError(`request failed: ${String(error)}`);
      if (attempt === maxRetries) break;
      await sleep(backoffSeconds * 2 ** attempt * 1000);
      continue;
    }

    if (response.status === 404) {
      throw new NotFoundError(`not found: ${url}`);
    }
    if (response.status >= 200 && response.status < 300) {
      return response.text;
    }
    if (response.status === 429) {
      if (isPlanRequired(response.text)) {
        // Never retried: no amount of waiting buys a subscription.
        throw new PlanRequiredError(
          `OpenAlex requires a paid plan for this query: ${response.text.slice(0, 200)}`,
        );
      }
      // Honour the server's own number when it gives one, rather than our
      // guess — and surface 429 as its own type, so a caller looping over
      // batches can stop instead of hammering a service that just asked it
      // to slow down.
      const wait = parseRetryAfter(response.retryAfter);
      lastError = new RateLimitError(`rate limited by ${url}`, wait);
      if (attempt === maxRetries) break;
      await sleep(wait ?? backoffSeconds * 2 ** attempt * 1000);
      continue;
    }

    lastError = new FetchError(`HTTP ${response.status} for ${url}`, response.status);
    if (!isRetryable(response.status) || attempt === maxRetries) break;
    await sleep(backoffSeconds * 2 ** attempt * 1000);
  }
  throw lastError ?? new FetchError(`request failed: ${url}`);
}

/**
 * Enforces a minimum gap between successive requests.
 *
 * The 150ms default sits just under OpenAlex's published 10/s ceiling rather
 * than exactly on it: at 100ms any clock jitter puts a burst over the line and
 * earns a 429, and the margin costs nothing on runs measured in tens of
 * requests.
 */
export class RateLimiter {
  private lastRequestAt = 0;

  constructor(
    private readonly minIntervalMs = 150,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async wait(): Promise<void> {
    const elapsed = this.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = this.now();
  }
}

/** Build a URL with query params, skipping undefined values. */
export function buildUrl(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}
