/*
 * One-way registration sync from Accelevents into Greenroom (brief feature 7, `PRD-INT-001`).
 *
 * **Direction, stated once.** Accelevents is the registration platform of record, so this reads
 * from it and writes into Greenroom. That is the direction that eliminates manual re-entry, which
 * is what the feature exists for. It is not the same thing as the `accelevents` *delivery*
 * channel, which pushes versioned projections outward and is unchanged — the two are separate,
 * both one-way, and `PRD-INT-001` names both.
 *
 * **What it writes, and how it stays out of content's tables.** Registrants become speaker
 * profiles through `ContentService.importSpeakers`, content's own public import command. That
 * command already owns the properties this feature needs — a preview that writes nothing, row
 * level validation, and per-email idempotency through content's speaker-import ledger — and
 * reimplementing them here would be a second, divergent importer over tables this domain must not
 * touch. The cost is that the sync speaks to it in the CSV dialect it accepts (see `asCsv`), and
 * that content records these speakers with `source.kind = "csv"` internally, because that is what
 * the command it went through is. Provenance is not lost: the Accelevents record id travels into
 * the profile's `customFields` and into this domain's own run record.
 *
 * **Credential-free by default.** The source is a port. `fixture` — the default — answers from a
 * deterministic in-repository roster, so `npm run check`, Playwright, the demo and a fresh clone
 * all sync without a credential or a network. `live` requires the Accelevents bindings and
 * throws naming the missing ones rather than falling back to the fixture.
 *
 * @spec PRD-INT-001 PORT-ACCELEVENTS
 */
import { type Actor, requireEventCapability } from "../identity/actor";

/**
 * One person as the registration platform holds them.
 *
 * `sourceRef` is Accelevents' own identifier for the record, and it is the reference this
 * feature's idempotency is described in terms of. Note where it does and does not bite: it is
 * carried onto the profile and into the run record for provenance, while the *convergence*
 * guarantee — applying twice produces the same rows — comes from content's import ledger, which
 * is keyed by normalized email. Two Accelevents records sharing one address are therefore one
 * speaker, which is the correct answer for a person who registered twice.
 */
export interface AccelEventsRegistrant {
  readonly sourceRef: string;
  readonly name: string;
  readonly email: string;
  readonly ticketType?: string | undefined;
}

/** Reading the registration platform. Implemented by the fixture and by the live HTTP client. */
export interface AccelEventsRegistrationSource {
  listRegistrants(eventId: string): Promise<readonly AccelEventsRegistrant[]>;
}

/** Raised when the source cannot be reached or answers something unusable. Never carries a token. */
export class AccelEventsUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Accelevents registration source failed: ${code}`);
  }
}

/** One row's disposition, as the organizer sees it. */
export interface AccelEventsSyncRow {
  readonly sourceRef: string;
  readonly name: string;
  readonly email: string;
  /** `create` and `skip` are predictions in a dry run and outcomes in an apply. */
  readonly disposition: "create" | "skip" | "invalid";
  readonly errors: readonly string[];
}

export interface AccelEventsSyncReport {
  /** True when nothing was written — the dry run. */
  readonly preview: boolean;
  readonly total: number;
  readonly created: number;
  readonly skipped: number;
  readonly invalid: number;
  readonly rows: readonly AccelEventsSyncRow[];
}

/** The last apply, for the organizer surface. Dry runs are not recorded — they change nothing. */
export interface AccelEventsSyncRun {
  readonly eventId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "failed";
  readonly total: number;
  readonly created: number;
  readonly skipped: number;
  readonly invalid: number;
  /** A normalized code when the run failed. Never a provider message or a credential. */
  readonly errorCode: string | null;
}

export interface AccelEventsSyncRunStore {
  record(run: AccelEventsSyncRun): Promise<void>;
  find(eventId: string): Promise<AccelEventsSyncRun | null>;
}

/** What content's import command answers, narrowed to what this module reads. */
interface SpeakerImportResult {
  readonly rows: readonly {
    readonly row: number;
    readonly name: string;
    readonly email: string;
    readonly duplicate: boolean;
    readonly errors: readonly string[];
  }[];
}

export interface AccelEventsSyncDependencies {
  readonly source: AccelEventsRegistrationSource;
  /** Content's public import command. This module knows no other way into content. */
  readonly content: {
    importSpeakers(
      actor: Actor | null,
      input: { eventId: string; csv: string; commit: boolean },
      correlationId: string,
    ): Promise<SpeakerImportResult>;
  };
  readonly runs: AccelEventsSyncRunStore;
  /** Which source `source` actually is, so the organizer surface can say so. */
  readonly mode: "fixture" | "live";
  readonly now: () => Date;
}

/**
 * RFC 4180 field quoting.
 *
 * Written out rather than joined with commas because a registrant called `Ada, Countess of
 * Lovelace` would otherwise split into two columns and import a person who does not exist — and
 * `customFields` below is JSON, which is nothing but commas and quotes. Quoting is the whole of
 * the rule: wrap when the value contains a delimiter, a quote or a line break, and double any
 * quote inside. `accelevents-sync.test.ts` round-trips this through the real `parseSpeakerCsv`
 * rather than trusting the two to agree.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Registrants as the CSV `parseSpeakerCsv` accepts.
 *
 * `customFields` carries the Accelevents identifiers onto the profile, which is what keeps the
 * provenance of an imported speaker visible to an organizer looking at the speaker rather than at
 * this feature's run log.
 */
function asCsv(registrants: readonly AccelEventsRegistrant[]): string {
  return [
    "name,email,workflowStatus,customFields",
    ...registrants.map((registrant) =>
      [
        registrant.name,
        registrant.email,
        // Registration is not acceptance: an imported registrant has not been onboarded, and
        // saying so is what puts them in the organizer's "still owes work" list.
        "invited",
        JSON.stringify({
          accelEventsRef: registrant.sourceRef,
          ...(registrant.ticketType ? { accelEventsTicket: registrant.ticketType } : {}),
        }),
      ]
        .map(csvField)
        .join(","),
    ),
  ].join("\n");
}

export class AccelEventsSyncService {
  constructor(private readonly dependencies: AccelEventsSyncDependencies) {}

  /**
   * Preview or apply the registration sync.
   *
   * A preview writes nothing anywhere: not into content, and not into this domain's run record.
   * That is the whole contract of a dry run, and recording it would make "last sync" a claim
   * about something that never happened.
   *
   * Authorization is checked here *before* the registration platform is read, and again by
   * `importSpeakers`, which demands the same capability. The duplication is deliberate: relying
   * on the import's check alone would mean an unauthorized caller still caused an outbound
   * request to a third party on every attempt — a denial the caller gets to bill to someone
   * else. Denial happens before anything leaves this Worker.
   */
  async sync(
    actor: Actor | null,
    eventId: string,
    options: { commit: boolean },
    correlationId: string,
  ): Promise<AccelEventsSyncReport> {
    requireEventCapability(actor, eventId, "content:manage");
    const startedAt = this.dependencies.now().toISOString();
    let registrants: readonly AccelEventsRegistrant[];
    try {
      registrants = await this.dependencies.source.listRegistrants(eventId);
    } catch (error) {
      // ERROR-INTENT: the source's own message is untrusted and can carry a URL or a token echoed
      // back in an error body; only a normalized code is stored or shown.
      const code =
        error instanceof AccelEventsUnavailableError ? error.code : "ACCELEVENTS_UNAVAILABLE";
      if (options.commit)
        await this.dependencies.runs.record({
          eventId,
          startedAt,
          completedAt: this.dependencies.now().toISOString(),
          outcome: "failed",
          total: 0,
          created: 0,
          skipped: 0,
          invalid: 0,
          errorCode: code,
        });
      throw new AccelEventsUnavailableError(code);
    }

    const result = await this.dependencies.content.importSpeakers(
      actor,
      { eventId, csv: asCsv(registrants), commit: options.commit },
      correlationId,
    );
    // Row order is preserved by the CSV, so row N+2 of the import is registrant N.
    const rows = result.rows.map((row, index): AccelEventsSyncRow => {
      const registrant = registrants[index];
      // `duplicate` is tested before `errors`, and the order matters. Content's importer records a
      // known address as a row error, which is right for a hand-pasted CSV — the operator pasted
      // something twice. For a sync it is the expected steady state: the second run finds every
      // registrant already imported. Reporting that as invalid would make a converged sync look
      // like a broken one.
      const disposition = row.duplicate ? "skip" : row.errors.length ? "invalid" : "create";
      return {
        sourceRef: registrant?.sourceRef ?? "",
        name: row.name,
        email: row.email,
        disposition,
        errors: disposition === "skip" ? [] : row.errors,
      };
    });
    const count = (disposition: AccelEventsSyncRow["disposition"]) =>
      rows.filter((row) => row.disposition === disposition).length;
    const report: AccelEventsSyncReport = {
      preview: !options.commit,
      total: rows.length,
      created: count("create"),
      skipped: count("skip"),
      invalid: count("invalid"),
      rows,
    };
    if (options.commit)
      await this.dependencies.runs.record({
        eventId,
        startedAt,
        completedAt: this.dependencies.now().toISOString(),
        outcome: "succeeded",
        total: report.total,
        created: report.created,
        skipped: report.skipped,
        invalid: report.invalid,
        errorCode: null,
      });
    return report;
  }

  /**
   * The integration's whole state, for the organizer surface.
   *
   * `mode` is on it deliberately. An organizer looking at "3 imported" needs to know whether that
   * came from their registration platform or from the in-repository roster the demo runs on, and
   * a surface that cannot tell them is one that will eventually mislead them.
   *
   * Authorization is the same as reading the event's content, which is the least this can be: the
   * answer names how many people registered.
   */
  async describe(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    mode: "fixture" | "live";
    direction: "inbound";
    lastRun: AccelEventsSyncRun | null;
  }> {
    requireEventCapability(actor, eventId, "content:manage");
    return {
      mode: this.dependencies.mode,
      direction: "inbound",
      lastRun: await this.dependencies.runs.find(eventId),
    };
  }
}
