/**
 * A fixed-window counter for the unauthenticated write paths.
 *
 * Deliberately the cheapest thing that works: a bounded map of counters in the isolate, no
 * binding, no round trip. That makes it *best effort* — Cloudflare may run many isolates, so
 * the effective ceiling is the configured limit times the number of live isolates, and a
 * cold isolate starts fresh. It exists to stop one client from flooding a single event's CFP
 * from one place, not to be a distributed quota; a hard quota needs KV or a Durable Object.
 *
 * Entries are evicted lazily as their windows expire, and the map is capped so a rotating key
 * space (a spoofed forwarded address per request) cannot grow it without bound.
 *
 * The cap evicts rather than refuses. Refusing a newcomer once the table is full would let one
 * client that rotates keys — a random event UUID per request is enough, since the key is formed
 * before the event is known to exist — lock every genuine submitter out for a whole window. A
 * rate limiter that fails closed on its own bookkeeping is a denial-of-service amplifier, so a
 * full table drops its oldest window instead. The worst an attacker gets is a reset counter for
 * somebody they evicted, which is the lenient direction.
 */
export interface ThrottleDecision {
  readonly allowed: boolean;
  /** Whole seconds until the current window ends, for `Retry-After`. */
  readonly retryAfterSeconds: number;
}

export class FixedWindowThrottle {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one attempt against `key` and say whether it may proceed. */
  check(key: string, now: number): ThrottleDecision {
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.evictExpired(now);
      // Still full after expiry: make room by dropping the oldest window. Every window is the
      // same length, so Map insertion order is `resetAt` order and the first key is the oldest.
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (oldest.done) break;
        this.windows.delete(oldest.value);
      }
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    return existing.count <= this.limit
      ? { allowed: true, retryAfterSeconds: 0 }
      : {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
  }

  /** Test seam: forget every window. */
  reset(): void {
    this.windows.clear();
  }

  private evictExpired(now: number) {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

/**
 * The throttle for `POST /api/public/events/{eventId}/submissions`.
 *
 * Module scope rather than per-app state on purpose: the worker builds a fresh app for every
 * request, so anything owned by `createHttpApp` would reset on each call and count nothing.
 */
export const submissionThrottle = new FixedWindowThrottle(10, 60_000);

/**
 * The caller's address as the edge saw it.
 *
 * `cf-connecting-ip` is written by Cloudflare and cannot be forged by the client; the
 * forwarded headers are only consulted for other deployments and are attacker-controlled, so
 * a caller who rotates them merely spreads themselves across buckets. That is only safe because
 * the key table evicts rather than refuses — see `FixedWindowThrottle`.
 */
export function clientAddress(headers: { get(name: string): string | null | undefined }): string {
  const direct = headers.get("cf-connecting-ip") ?? headers.get("x-real-ip");
  if (direct) return direct.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
