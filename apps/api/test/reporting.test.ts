// @acceptance ACC-OPS
/**
 * The report engine, the PII rule, and the share link that carries it.
 *
 * The engine half is pure, which is the point of separating it: filtering, grouping, sorting,
 * paging and masking can each be asserted without a database, a session or a domain service,
 * because the authorization happened before the rows arrived.
 *
 * The service half asserts the three ways this surface could leak — an export that shows what the
 * screen would not, a share link that outlives the access that justified it, and a schedule that
 * delivers twice — and it asserts each by constructing the case rather than by trusting the code.
 */
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { renderReportCsv, renderReportXlsx } from "../src/adapters/platform/render-report-export";
import type { Actor, Capability } from "../src/application/identity/actor";
import { CapabilityDeniedError } from "../src/application/identity/actor";
import type {
  CapabilityLink,
  CapabilityLinkStore,
} from "../src/application/platform/capability-link";
import {
  MAX_REPORT_SCAN,
  maskValue,
  ReportQueryInvalidError,
  type ReportRow,
  ReportTooExpensiveError,
  runQuery,
  validateQuery,
} from "../src/application/platform/report-catalogue";
import {
  occurrenceKey,
  ReportingService,
  ReportPiiDeniedError,
  type ReportRepository,
  ReportShareUnavailableError,
} from "../src/application/platform/reporting-service";

const EVENT = "00000000-0000-4000-8000-0000000000a1";
const ORGANIZATION = "00000000-0000-4000-8000-0000000000a0";
const NOW = new Date("2026-08-14T09:30:00.000Z");

const speakerRows: ReportRow[] = [
  {
    name: "Ada",
    email: "ada@example.test",
    organization: "Difference",
    workflowStatus: "ready",
    openTasks: 0,
  },
  {
    name: "Bea",
    email: "bea@example.test",
    organization: "Difference",
    workflowStatus: "invited",
    openTasks: 2,
  },
  {
    name: "Cai",
    email: "cai@example.test",
    organization: "Analytical",
    workflowStatus: "ready",
    openTasks: 1,
  },
];

const actorOf = (capabilities: readonly Capability[]): Actor => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [{ eventId: EVENT, role: "organizer", capabilities: new Set(capabilities) }],
  capabilities: new Set(capabilities),
});

/** Every entry of an XLSX, as text, so an assertion reads the sheet rather than the archive. */
const unzipStrings = (workbook: Uint8Array): string[] => {
  const decoder = new TextDecoder();
  return Object.values(unzipSync(workbook)).map((entry) => decoder.decode(entry));
};

const organizer = actorOf(["events:read", "reports:pii"]);
const scoped = actorOf(["events:read"]);

describe("the report query engine", () => {
  it("refuses a field, an operator and a grouping the catalogue does not have", () => {
    expect(() => validateQuery({ dataset: "nope" })).toThrow(ReportQueryInvalidError);
    expect(() => validateQuery({ dataset: "speakers", fields: ["salary"] })).toThrow(
      ReportQueryInvalidError,
    );
    expect(() =>
      validateQuery({
        dataset: "speakers",
        filters: [{ field: "email", operator: "sounds-like", value: "x" }],
      }),
    ).toThrow(ReportQueryInvalidError);
    expect(() => validateQuery({ dataset: "speakers", groupBy: "salary" })).toThrow(
      ReportQueryInvalidError,
    );
    // A comparison that takes an operand and was given none is a refusal rather than a match-all.
    expect(() =>
      validateQuery({ dataset: "speakers", filters: [{ field: "email", operator: "contains" }] }),
    ).toThrow(ReportQueryInvalidError);
  });

  it("selects every field when none is named, and keeps catalogue order", () => {
    const query = validateQuery({ dataset: "speakers" });
    expect(query.fields).toEqual(["name", "email", "organization", "workflowStatus", "openTasks"]);
  });

  it("filters, groups, sorts and pages, and reports what it scanned", () => {
    const query = validateQuery({
      dataset: "speakers",
      fields: ["name", "organization"],
      filters: [{ field: "organization", operator: "equals", value: "difference" }],
      groupBy: "organization",
      sort: { field: "name", direction: "desc" },
      limit: 1,
    });
    const result = runQuery(query, speakerRows, { includePii: true });
    expect(result.rows).toEqual([{ name: "Bea", organization: "Difference" }]);
    expect(result.totalRows).toBe(2);
    expect(result.groups).toEqual([{ value: "Difference", count: 2 }]);
    expect(result.meta).toMatchObject({ scannedRows: 3, limit: 1, offset: 0 });
  });

  it("masks personal fields unless the run asked for them, and says which it masked", () => {
    const query = validateQuery({ dataset: "speakers", fields: ["name", "email"] });
    const masked = runQuery(query, speakerRows, { includePii: false });
    expect(masked.rows[0]).toEqual({ name: "Ada", email: "a…@example.test" });
    expect(masked.meta.maskedFields).toEqual(["email"]);
    const unmasked = runQuery(query, speakerRows, { includePii: true });
    expect(unmasked.rows[0]).toEqual({ name: "Ada", email: "ada@example.test" });
    expect(unmasked.meta.maskedFields).toEqual([]);
  });

  it("filters on the unmasked value, so a saved report means one thing", () => {
    // Masking is about what leaves, not about what matches. A report filtered on a masked value
    // would answer differently depending on who ran it.
    const query = validateQuery({
      dataset: "speakers",
      fields: ["name", "email"],
      filters: [{ field: "email", operator: "contains", value: "ada@" }],
    });
    expect(runQuery(query, speakerRows, { includePii: false }).totalRows).toBe(1);
  });

  it("refuses a scan larger than the cost bound, with an actionable message", () => {
    const query = validateQuery({ dataset: "speakers" });
    const many = Array.from({ length: MAX_REPORT_SCAN + 1 }, () => speakerRows[0] as ReportRow);
    expect(() => runQuery(query, many, { includePii: false })).toThrow(ReportTooExpensiveError);
  });

  it("masks enough to tell two rows apart and not enough to reach anybody", () => {
    expect(maskValue("ada@example.test")).toBe("a…@example.test");
    expect(maskValue("Ada Lovelace")).toBe("A…e");
    expect(maskValue("")).toBe("");
    // Deliberately not a hash: a hash is stable across reports and therefore a join key onto the
    // very data the masking exists to withhold.
    expect(maskValue("ada@example.test")).not.toMatch(/^[a-f0-9]{16,}$/);
  });
});

function harness(over: { rows?: ReportRow[]; unauthorized?: boolean } = {}) {
  const stored = new Map<string, Awaited<ReturnType<ReportingService["save"]>>>();
  const links: (CapabilityLink & { tokenHash: string; passwordHash: string | null })[] = [];
  const runs: { id: string; scheduleId: string; occurrenceKey: string; outcome: string }[] = [];
  const claims = new Set<string>();
  const schedules: Awaited<ReturnType<ReportingService["createSchedule"]>>[] = [];
  const delivered: { recipients: readonly string[]; url: string }[] = [];
  let nextId = 0;

  const repository: ReportRepository = {
    list: async (eventId) => [...stored.values()].filter((r) => r.eventId === eventId),
    find: async (eventId, id) => {
      const held = stored.get(id);
      return held && held.eventId === eventId ? held : null;
    },
    findById: async (id) => stored.get(id) ?? null,
    create: async (report) => {
      stored.set(report.id, report);
    },
    update: async (report, expected) => {
      const held = stored.get(report.id);
      if (!held || held.revision !== expected) return 0;
      stored.set(report.id, report);
      return 1;
    },
    remove: async (eventId, id, expected) => {
      const held = stored.get(id);
      if (!held || held.eventId !== eventId || held.revision !== expected) return 0;
      stored.delete(id);
      return 1;
    },
    createSchedule: async (schedule) => {
      schedules.push(schedule);
    },
    listSchedules: async (reportId) => schedules.filter((s) => s.reportId === reportId),
    removeSchedule: async () => 1,
    listDueSchedules: async () => schedules.map((s) => ({ ...s, eventId: EVENT })),
    claimRun: async (run, key) => {
      const claimKey = `${run.scheduleId}:${key}`;
      if (claims.has(claimKey)) return false;
      claims.add(claimKey);
      const index = schedules.findIndex((s) => s.id === run.scheduleId);
      if (index >= 0)
        schedules[index] = {
          ...(schedules[index] as (typeof schedules)[number]),
          lastFiredKey: key,
        };
      return true;
    },
    recordRun: async (run) => {
      runs.push({
        id: run.id,
        scheduleId: run.scheduleId,
        occurrenceKey: run.occurrenceKey,
        outcome: run.outcome,
      });
    },
    listRuns: async () => [],
  };

  const linkStore: CapabilityLinkStore = {
    create: async (link) => {
      links.push(link);
    },
    list: async (kind, ref) =>
      links.filter((link) => link.kind === kind && link.resourceRef === ref),
    revoke: async (kind, ref, id, at) => {
      const index = links.findIndex(
        (link) => link.kind === kind && link.resourceRef === ref && link.id === id,
      );
      if (index < 0) return 0;
      links[index] = { ...(links[index] as (typeof links)[number]), revokedAt: at };
      return 1;
    },
    spend: async (tokenHash, kind, passwordHash, now) => {
      const index = links.findIndex(
        (link) =>
          link.tokenHash === tokenHash &&
          link.kind === kind &&
          link.revokedAt === null &&
          link.expiresAt > now &&
          (link.passwordHash === null || link.passwordHash === passwordHash) &&
          (link.viewLimit === null || link.views < link.viewLimit),
      );
      if (index < 0) return null;
      const held = links[index] as (typeof links)[number];
      links[index] = { ...held, views: held.views + 1 };
      return { ...held, views: held.views + 1 };
    },
  };

  const service = new ReportingService({
    repository,
    links: linkStore,
    sources: {
      events: { organizationOf: async () => ORGANIZATION },
      content: {
        workspace: async () => {
          // The refusal the owning domain actually raises, so `readSource` classifies it as the
          // authorization model working rather than as an outage.
          if (over.unauthorized) throw new CapabilityDeniedError("Content workspace access denied");
          return {
            sessions: [],
            speakers: (over.rows ?? speakerRows).map((row, index) => ({
              id: `speaker-${index}`,
              name: String(row.name),
              email: row.email === null ? undefined : String(row.email),
              organization: row.organization === null ? undefined : String(row.organization),
              workflowStatus: row.workflowStatus === null ? undefined : String(row.workflowStatus),
            })),
            tasks: [],
          };
        },
      },
    },
    audit: { record: vi.fn(async () => undefined) },
    delivery: {
      deliver: async ({ recipients, url }) => {
        delivered.push({ recipients, url });
      },
    },
    mintToken: async () => {
      const token = `token-${nextId++}`.padEnd(20, "x");
      return { token, tokenHash: `hash:${token}` };
    },
    // The real renderers, so what this asserts is the bytes somebody downloads rather than a
    // stand-in that could mask differently from the shipped one.
    exports: { csv: renderReportCsv, xlsx: renderReportXlsx },
    hash: async (value) => `hash:${value}`,
    shareBaseUrl: "https://greenroom.test",
    newId: () => `00000000-0000-4000-8000-0000000000${(nextId++).toString().padStart(2, "0")}`,
    now: () => NOW,
  });
  return { service, links, runs, delivered, schedules, claims };
}

const savedReport = (service: ReportingService) =>
  service.save(organizer, EVENT, {
    name: "Speaker onboarding",
    dataset: "speakers",
    fields: ["name", "email"],
  });

describe("running and saving a report", () => {
  it("masks for a caller without the capability and refuses one who asks anyway", async () => {
    const { service } = harness();
    const report = await savedReport(service);
    const masked = await service.run(scoped, EVENT, { reportId: report.id });
    expect(masked.state).toBe("ok");
    if (masked.state === "ok") expect(masked.result.rows[0]?.email).toBe("a…@example.test");
    // Holding the capability is not a standing instruction: unmasking needs an explicit ask.
    const notAsked = await service.run(organizer, EVENT, { reportId: report.id });
    if (notAsked.state === "ok") expect(notAsked.result.rows[0]?.email).toBe("a…@example.test");
    await expect(
      service.run(scoped, EVENT, { reportId: report.id, includePii: true }),
    ).rejects.toThrow(ReportPiiDeniedError);
    const unmasked = await service.run(organizer, EVENT, {
      reportId: report.id,
      includePii: true,
    });
    if (unmasked.state === "ok") expect(unmasked.result.rows[0]?.email).toBe("ada@example.test");
  });

  /*
   * The export is the half a screen assertion cannot reach.
   *
   * A masked screen and an unmasked file is the failure this whole design exists to prevent, and
   * it is invisible from the console — nobody notices the CSV disagrees with the table until the
   * file is somewhere it should not be. So the bytes are read back, in each of the three formats,
   * for a caller who cannot unmask and for one who can.
   */
  it("exports what the screen would show, in every format, for a caller who cannot unmask", async () => {
    const { service } = harness();
    const report = await savedReport(service);

    const csv = await service.export(scoped, EVENT, { reportId: report.id, format: "csv" });
    expect(csv.state).toBe("ok");
    if (csv.state === "ok") {
      expect(String(csv.body)).toContain("a…@example.test");
      expect(String(csv.body)).not.toContain("ada@example.test");
    }

    const json = await service.export(scoped, EVENT, { reportId: report.id, format: "json" });
    expect(json.state).toBe("ok");
    if (json.state === "ok") {
      expect(String(json.body)).toContain("a…@example.test");
      expect(String(json.body)).not.toContain("ada@example.test");
    }

    // XLSX is a zip, so the address is asserted against the decompressed sheet rather than the
    // archive — a `not.toContain` over compressed bytes would pass for the wrong reason.
    const xlsx = await service.export(scoped, EVENT, { reportId: report.id, format: "xlsx" });
    expect(xlsx.state).toBe("ok");
    if (xlsx.state === "ok") {
      const sheets = unzipStrings(xlsx.body as Uint8Array);
      expect(sheets.some((entry) => entry.includes("a…@example.test"))).toBe(true);
      expect(sheets.some((entry) => entry.includes("ada@example.test"))).toBe(false);
    }
  });

  it("refuses an unmasked export to a caller without reports:pii, and serves one to a caller with it", async () => {
    const { service } = harness();
    const report = await savedReport(service);

    // The same refusal the screen raises. An export is a format applied to a run, not a second
    // path to the rows, so it cannot be the softer of the two.
    await expect(
      service.export(scoped, EVENT, { reportId: report.id, format: "csv", includePii: true }),
    ).rejects.toThrow(ReportPiiDeniedError);

    const allowed = await service.export(organizer, EVENT, {
      reportId: report.id,
      format: "csv",
      includePii: true,
    });
    expect(allowed.state).toBe("ok");
    if (allowed.state === "ok") expect(String(allowed.body)).toContain("ada@example.test");

    // Holding the capability is still not a standing instruction.
    const notAsked = await service.export(organizer, EVENT, {
      reportId: report.id,
      format: "csv",
    });
    expect(notAsked.state).toBe("ok");
    if (notAsked.state === "ok") expect(String(notAsked.body)).not.toContain("ada@example.test");
  });

  it("degrades to unauthorized rather than refusing when a source says no", async () => {
    const { service } = harness({ unauthorized: true });
    const report = await savedReport(service);
    const answer = await service.run(organizer, EVENT, { reportId: report.id });
    // A refusal from the owning domain is the authorization model working; the surface stays open
    // and names the dataset the caller cannot read rather than failing the whole request.
    expect(answer.state).toBe("unauthorized");
  });
});

describe("share links", () => {
  it("serves masked rows through a link created without the PII decision", async () => {
    const { service, links } = harness();
    const report = await savedReport(service);
    const created = await service.createShare(organizer, EVENT, report.id, {
      lifetimeHours: 24,
    });
    expect(created.url).toContain("https://greenroom.test/reports/");
    const resolved = await service.resolveShare(created.token);
    expect(resolved.result.rows[0]?.email).toBe("a…@example.test");
    expect(links[0]?.scope).toEqual({
      allowPii: false,
      capabilities: ["events:read", "reports:pii"],
      fieldPolicies: [],
    });
  });

  it("freezes the same least-restrictive field decision used by live projections", async () => {
    const { service, links } = harness();
    const report = await savedReport(service);
    const multiGrant = {
      ...scoped,
      eventAccess: [
        {
          eventId: EVENT,
          role: "custom" as const,
          capabilities: new Set(["events:read"] as const),
          fieldPolicies: new Map([["speaker:email", "hide" as const]]),
        },
        {
          eventId: EVENT,
          role: "custom" as const,
          capabilities: new Set(["events:read"] as const),
          fieldPolicies: new Map([["speaker:email", "lock" as const]]),
        },
      ],
    };
    await service.createShare(multiGrant, EVENT, report.id, { lifetimeHours: 24 });
    expect(links.at(-1)?.scope.fieldPolicies).toEqual([["speaker:email", "lock"]]);

    await service.createShare(
      { ...multiGrant, eventAccess: [...multiGrant.eventAccess, organizer.eventAccess[0]!] },
      EVENT,
      report.id,
      { lifetimeHours: 24 },
    );
    expect(links.at(-1)?.scope.fieldPolicies).toEqual([]);
  });

  it("refuses a caller without reports:pii asking for an unmasked link", async () => {
    const { service } = harness();
    const report = await savedReport(service);
    await expect(
      service.createShare(scoped, EVENT, report.id, { lifetimeHours: 24, allowPii: true }),
    ).rejects.toThrow(ReportPiiDeniedError);
  });

  it("spends one view, and answers a spent, revoked or wrong-password link alike", async () => {
    const { service } = harness();
    const report = await savedReport(service);
    const oneView = await service.createShare(organizer, EVENT, report.id, {
      lifetimeHours: 24,
      viewLimit: 1,
    });
    await expect(service.resolveShare(oneView.token)).resolves.toBeTruthy();
    await expect(service.resolveShare(oneView.token)).rejects.toThrow(ReportShareUnavailableError);

    const revocable = await service.createShare(organizer, EVENT, report.id, {
      lifetimeHours: 24,
    });
    await service.revokeShare(organizer, EVENT, report.id, revocable.share.id);
    await expect(service.resolveShare(revocable.token)).rejects.toThrow(
      ReportShareUnavailableError,
    );

    const guarded = await service.createShare(organizer, EVENT, report.id, {
      lifetimeHours: 24,
      viewLimit: 1,
      password: "correct horse",
    });
    await expect(service.resolveShare(guarded.token)).rejects.toThrow(ReportShareUnavailableError);
    await expect(service.resolveShare(guarded.token, "wrong")).rejects.toThrow(
      ReportShareUnavailableError,
    );
    await expect(service.resolveShare(guarded.token, "correct horse")).resolves.toBeTruthy();
    await expect(service.resolveShare(guarded.token, "correct horse")).rejects.toThrow(
      ReportShareUnavailableError,
    );
    await expect(service.resolveShare("token-that-never-existed")).rejects.toThrow(
      ReportShareUnavailableError,
    );
  });
});

describe("scheduled delivery", () => {
  it("names an occurrence by local wall clock, so a retried tick is one delivery", () => {
    const daily = {
      cadence: "daily" as const,
      minuteOfDay: 9 * 60,
      dayOfWeek: null,
      dayOfMonth: null,
      timezone: "Europe/London",
    };
    // 09:30 UTC is 10:30 in London on this date, so the 09:00 occurrence has arrived.
    expect(occurrenceKey(daily, NOW)).toBe("daily:2026-08-14");
    // Two instants inside the same local day produce the same key, which is what the unique
    // index turns into one delivery.
    expect(occurrenceKey(daily, new Date("2026-08-14T18:00:00.000Z"))).toBe("daily:2026-08-14");
    // Before the local time, it is not due.
    expect(occurrenceKey(daily, new Date("2026-08-14T02:00:00.000Z"))).toBeNull();
    // A zone this deployment cannot resolve never fires rather than firing at UTC.
    expect(occurrenceKey({ ...daily, timezone: "Mars/Olympus" }, NOW)).toBeNull();
    const weekly = { ...daily, cadence: "weekly" as const, dayOfWeek: 5 };
    // 2026-08-14 is a Friday.
    expect(occurrenceKey(weekly, NOW)).toBe("weekly:2026-08-14");
    expect(occurrenceKey({ ...weekly, dayOfWeek: 1 }, NOW)).toBeNull();
  });

  it("delivers a link once per occurrence and records the run", async () => {
    const { service, delivered, runs, links } = harness();
    const report = await savedReport(service);
    await service.createSchedule(organizer, EVENT, report.id, {
      cadence: "daily",
      minuteOfDay: 9 * 60,
      timezone: "Europe/London",
      recipients: ["ops@example.test", "OPS@example.test"],
    });
    expect((await service.tick()).fired).toBe(1);
    // A second tick inside the same local day fires nothing.
    expect((await service.tick()).fired).toBe(0);
    expect(delivered).toHaveLength(1);
    // Duplicated addresses converge, so one person is not sent the same report twice.
    expect(delivered[0]?.recipients).toEqual(["ops@example.test"]);
    expect(runs).toHaveLength(1);
    // A scheduled link never carries unmasked personal data, and holds only the event authority
    // frozen when the recurring instruction was created.
    expect(links.at(-1)?.scope).toEqual({
      allowPii: false,
      capabilities: ["events:read", "reports:pii"],
      fieldPolicies: [],
    });
    const token = delivered[0]?.url.split("/").at(-1);
    expect(token).toBeTruthy();
    const resolved = await service.resolveShare(token ?? "");
    expect(resolved.result.rows[0]?.email).toBe("a…@example.test");
  });

  it("claims before delivery, so overlapping ticks cannot send the same occurrence twice", async () => {
    const { service, delivered, runs, claims } = harness();
    const report = await savedReport(service);
    await service.createSchedule(organizer, EVENT, report.id, {
      cadence: "daily",
      minuteOfDay: 9 * 60,
      timezone: "Europe/London",
      recipients: ["ops@example.test"],
    });
    let releaseDelivery: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const concurrent = new ReportingService({
      ...(service as unknown as { dependencies: ConstructorParameters<typeof ReportingService>[0] })
        .dependencies,
      delivery: {
        deliver: async (delivery) => {
          delivered.push(delivery);
          announceStarted?.();
          await release;
        },
      },
    });

    const first = concurrent.tick();
    await started;
    await expect(concurrent.tick()).resolves.toEqual({ fired: 0, failed: 0 });
    expect(delivered).toHaveLength(1);
    expect(claims.size).toBe(1);
    expect(runs).toHaveLength(0);
    releaseDelivery?.();
    await expect(first).resolves.toEqual({ fired: 1, failed: 0 });
    expect(runs[0]?.outcome).toBe("delivered");
  });

  it("records a failed delivery instead of aborting the tick", async () => {
    const { service, runs, links } = harness();
    const report = await savedReport(service);
    await service.createSchedule(organizer, EVENT, report.id, {
      cadence: "daily",
      minuteOfDay: 9 * 60,
      timezone: "Europe/London",
      recipients: ["ops@example.test"],
    });
    // Replace the delivery with one that refuses, the way an unconfigured provider does.
    const broken = new ReportingService({
      ...(service as unknown as { dependencies: ConstructorParameters<typeof ReportingService>[0] })
        .dependencies,
      delivery: {
        deliver: async () => {
          throw new Error("provider refused");
        },
      },
    });
    const outcome = await broken.tick();
    expect(outcome).toEqual({ fired: 0, failed: 1 });
    expect(runs[0]?.outcome).toBe("failed");
    expect(links.at(-1)?.revokedAt).toBe(NOW.toISOString());
  });

  it("records a migrated empty-scope schedule as failed without sending a dead link", async () => {
    const { service, runs, links, delivered, schedules } = harness();
    const report = await savedReport(service);
    await service.createSchedule(organizer, EVENT, report.id, {
      cadence: "daily",
      minuteOfDay: 9 * 60,
      timezone: "Europe/London",
      recipients: ["ops@example.test"],
    });
    schedules[0] = { ...schedules[0]!, scope: {} };

    await expect(service.tick()).resolves.toEqual({ fired: 0, failed: 1 });
    expect(delivered).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(runs[0]?.outcome).toBe("failed");
  });
});
