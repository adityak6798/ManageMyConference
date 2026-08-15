// @acceptance ACC-OPS
/** The scheduled-report claim and immutable result lifecycle against real D1. */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1ReportRepository,
  type ReportDatabasePort,
} from "../src/adapters/persistence/d1-report-repository";
import type { ReportRun } from "../src/application/platform/reporting-service";
import { createMigratedDatabase } from "./support/seeded-d1";

const EVENT = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const REPORT = "00000000-0000-4000-8000-0000000000a1";
const SCHEDULE = "00000000-0000-4000-8000-0000000000a2";
const RUN = "00000000-0000-4000-8000-0000000000a3";
const NOW = "2026-08-14T09:00:00.000Z";

describe("scheduled report claims against D1", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "report-claims" });
    runtime = migrated.runtime;
    const repository = new D1ReportRepository(migrated.database as unknown as ReportDatabasePort);
    await repository.create({
      id: REPORT,
      eventId: EVENT,
      organizationId: ORGANIZATION,
      name: "Claim evidence",
      description: "",
      dataset: "speakers",
      query: { dataset: "speakers", fields: ["name"], filters: [], limit: 50, offset: 0 },
      createdBy: "seed-organizer",
      createdAt: NOW,
      updatedAt: NOW,
      revision: 1,
    });
    await repository.createSchedule({
      id: SCHEDULE,
      reportId: REPORT,
      cadence: "daily",
      minuteOfDay: 0,
      dayOfWeek: null,
      dayOfMonth: null,
      timezone: "UTC",
      recipients: ["ops@example.test"],
      linkLifetimeHours: 1,
      createdBy: "seed-organizer",
      createdAt: NOW,
      pausedAt: null,
      lastFiredKey: null,
      scope: { allowPii: false },
    });
    return { database: migrated.database, repository };
  }

  const run: ReportRun = {
    id: RUN,
    scheduleId: SCHEDULE,
    occurrenceKey: "daily:2026-08-14",
    ranAt: NOW,
    outcome: "failed",
    detail: "Delivery did not complete.",
  };

  it("admits one pre-delivery claim and keeps an interrupted claim visible", async () => {
    const { repository } = await stack();
    const [first, second] = await Promise.all([
      repository.claimRun(run, run.occurrenceKey),
      repository.claimRun({ ...run, id: `${RUN}-other` }, run.occurrenceKey),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(await repository.listRuns(SCHEDULE, 10)).toEqual([run]);
  });

  it("appends the final result without mutating the report history", async () => {
    const { database, repository } = await stack();
    expect(await repository.claimRun(run, run.occurrenceKey)).toBe(true);
    await repository.recordRun({ ...run, outcome: "delivered", detail: "" });
    expect(await repository.listRuns(SCHEDULE, 10)).toEqual([
      { ...run, outcome: "delivered", detail: "" },
    ]);
    await expect(
      database.prepare("UPDATE report_runs SET outcome = 'failed' WHERE id = ?").bind(RUN).run(),
    ).rejects.toThrow(/append-only/i);
  });
});
