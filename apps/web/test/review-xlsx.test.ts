// @acceptance ACC-REVIEW
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { renderReviewXlsx } from "../src/review/xlsx";

describe("review XLSX exports", () => {
  it("preserves non-BMP characters as valid XML code points", () => {
    const files = unzipSync(renderReviewXlsx([["Session 🚀", "bad\u0001value"]]));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"] ?? new Uint8Array());

    expect(sheet).toContain("Session 🚀");
    expect(sheet).toContain("badvalue");
    expect(sheet).not.toContain("\u0001");
  });
});
