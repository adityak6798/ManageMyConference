/**
 * A D1 handle that records every round trip made through it, and when.
 *
 * Issue #207 asks where the seconds go in a speaker acceptance, and the honest unit for that is
 * **round trips**, not local wall-clock. Locally D1 is a SQLite file inside Miniflare and a
 * statement costs tens of microseconds; in the deployed Worker every `prepare().run()`,
 * `prepare().all()` and `batch()` is a request to the D1 service, and a serialized chain of them
 * costs its length times that latency. A measurement taken on the local fixture therefore has to
 * report the count as well as the clock, because only one of the two survives the trip to a
 * deployment.
 *
 * `batch` counts as **one** round trip however many statements it carries — which is exactly why
 * the repositories reach for it — so the count answers "how many times did this request wait for
 * the database", which is the question.
 *
 * Concurrency is recorded too. Two reads issued through one `Promise.all` are two round trips
 * that cost one latency between them, so a count alone would understate a fix that only
 * parallelized. Each entry carries the instant it was issued and the instant it settled, and
 * `criticalPath` folds those into the number of *sequential* waits.
 */
export interface RoundTrip {
  readonly phase: string;
  readonly kind: "run" | "all" | "batch";
  /** Statements in the call — one, except for a batch. */
  readonly statements: number;
  readonly sql: string;
  readonly startedAt: number;
  readonly settledAt: number;
}

export interface RoundTripLog {
  readonly entries: readonly RoundTrip[];
  /** Round trips recorded during `work`, attributed to `name`. */
  measure<T>(name: string, work: () => Promise<T>): Promise<{ result: T; trips: RoundTrip[] }>;
  reset(): void;
}

/**
 * How many round trips are on the longest serialized chain.
 *
 * Round trips that overlap in time were waited for together, so they cost one latency between
 * them rather than two. A group of overlapping calls counts as one wait, which is the number
 * that scales with a deployment's round-trip time.
 */
export function criticalPath(trips: readonly RoundTrip[]): number {
  let waits = 0;
  let openUntil = Number.NEGATIVE_INFINITY;
  for (const trip of [...trips].sort((left, right) => left.startedAt - right.startedAt)) {
    if (trip.startedAt >= openUntil) {
      waits += 1;
      openUntil = trip.settledAt;
    } else openUntil = Math.max(openUntil, trip.settledAt);
  }
  return waits;
}

/** A one-line-per-phase summary, for a PR body or a failing assertion. */
export function summarize(trips: readonly RoundTrip[]): string {
  const phases = [...new Set(trips.map(({ phase }) => phase))];
  return phases
    .map((phase) => {
      const own = trips.filter((trip) => trip.phase === phase);
      const statements = own.reduce((total, trip) => total + trip.statements, 0);
      return `${phase}: ${own.length} round trips (${criticalPath(own)} sequential, ${statements} statements)`;
    })
    .join("\n");
}

interface Statement {
  bind(...values: unknown[]): Statement;
  run<T = unknown>(): Promise<unknown>;
  all<T>(): Promise<unknown>;
}
interface Database {
  prepare(query: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<unknown>;
}

/** Wrap a D1 handle so every call through it is recorded. The handle itself is untouched. */
export function recordRoundTrips<T extends Database>(
  database: T,
): { database: T; log: RoundTripLog } {
  const entries: RoundTrip[] = [];
  let phase = "unattributed";
  // A batch is handed the wrappers `prepare` returned, so the driver has to be given back the
  // statements it actually made. Kept beside the wrapper because the two are one mechanism.
  const underlying = new WeakMap<Statement, Statement>();

  const record = async <R>(
    kind: RoundTrip["kind"],
    sql: string,
    statements: number,
    work: () => Promise<R>,
  ): Promise<R> => {
    const startedAt = performance.now();
    const attributed = phase;
    try {
      return await work();
    } finally {
      entries.push({
        phase: attributed,
        kind,
        statements,
        sql: sql.replace(/\s+/g, " ").trim().slice(0, 120),
        startedAt,
        settledAt: performance.now(),
      });
    }
  };

  const track = (statement: Statement, sql: string): Statement => {
    const tracked: Statement = {
      bind: (...values: unknown[]) => track(statement.bind(...values), sql),
      run: <R>() => record("run", sql, 1, () => statement.run<R>() as Promise<R>),
      all: <R>() => record("all", sql, 1, () => statement.all<R>() as Promise<R>),
    };
    underlying.set(tracked, statement);
    return tracked;
  };

  /*
   * A `Proxy` rather than `{ ...database, prepare, batch }`.
   *
   * Spreading a class instance keeps only its own enumerable properties, so every prototype
   * method other than the two overridden here — `exec`, `dump`, `withSession` on a real D1
   * handle — is silently dropped. Nothing reaches for them today, so the spread passed; what it
   * would have produced is a repository failing with "not a function" *only inside this suite*,
   * which is a confusing signal from a gate whose whole subject is counting round trips.
   */
  const overrides: Record<string, unknown> = {
    prepare: (query: string) => track(database.prepare(query), query),
    batch: <R>(statements: Statement[]) =>
      record(
        "batch",
        `BATCH of ${statements.length}`,
        statements.length,
        () =>
          database.batch<R>(
            statements.map((statement) => underlying.get(statement) ?? statement),
          ) as Promise<R>,
      ),
  };
  const proxy = new Proxy(database as object, {
    get: (target, property, receiver) => {
      // `Object.hasOwn` rather than `in`: `in` walks `Object.prototype`, so `toString`,
      // `valueOf`, `constructor` and `hasOwnProperty` would all resolve out of this literal
      // instead of the handle — the same silent shadowing the spread this replaced was guilty
      // of, at smaller radius.
      if (Object.hasOwn(overrides, property)) return overrides[property as string];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as T;

  return {
    database: proxy,
    log: {
      entries,
      measure: async (name, work) => {
        const before = entries.length;
        const previous = phase;
        phase = name;
        try {
          return { result: await work(), trips: entries.slice(before) };
        } finally {
          phase = previous;
        }
      },
      reset: () => {
        entries.length = 0;
      },
    },
  };
}
