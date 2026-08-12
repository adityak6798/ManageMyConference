// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { changedRows } from "../src/adapters/persistence/d1-write-result";

describe("D1 affected-row contract", () => {
  it("refuses a successful write whose driver omitted meta.changes", () => {
    expect(() => changedRows({ success: true } as never, "update a conditional row")).toThrow(
      "D1 reported no row count while attempting to update a conditional row",
    );
  });

  it("preserves zero as a reported row count", () => {
    expect(changedRows({ success: true, meta: { changes: 0 } }, "update a conditional row")).toBe(
      0,
    );
  });
});
