// @acceptance ACC-SPEAKER
import { describe, expect, it } from "vitest";
import { parseSpeakerCsv } from "../src/adapters/content/parse-speaker-csv";

describe("speaker CSV import parsing", () => {
  it("handles quoted commas and preserves row numbers for malformed input", () => {
    const parsed = parseSpeakerCsv(
      'name,email,workflowStatus\n"Doe, Alex",alex@example.test,ready\nSam,sam@example.test,onboarding',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        name: "Doe, Alex",
        email: "alex@example.test",
        workflowStatus: "ready",
        logistics: undefined,
        customFields: undefined,
      },
      {
        name: "Sam",
        email: "sam@example.test",
        workflowStatus: "onboarding",
        logistics: undefined,
        customFields: undefined,
      },
    ]);
  });
});
