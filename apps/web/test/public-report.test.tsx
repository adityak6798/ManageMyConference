// @acceptance ACC-OPS
import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const { resolvePublicReport } = vi.hoisted(() => ({ resolvePublicReport: vi.fn() }));

vi.mock("../src/api/reports", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("../src/api/reports")>()),
  resolvePublicReport,
}));

import { PublicReportApp } from "../src/PublicReportApp";

beforeEach(() => {
  window.history.replaceState({}, "", "/reports/one-view-token");
  resolvePublicReport.mockReset();
});

it("spends an initial finite-view capability once under StrictMode", async () => {
  resolvePublicReport.mockResolvedValue({
    report: { name: "Shared programme", description: "" },
    result: {
      fields: [{ key: "title", label: "Title" }],
      rows: [{ title: "Opening keynote" }],
      groups: [],
      totalRows: 1,
      meta: { scannedRows: 1, limit: 100, offset: 0, maskedFields: [] },
    },
  });

  render(
    <StrictMode>
      <PublicReportApp />
    </StrictMode>,
  );

  expect(await screen.findByRole("heading", { name: "Shared programme" })).toBeVisible();
  expect(screen.getByText("Opening keynote")).toBeVisible();
  expect(resolvePublicReport).toHaveBeenCalledTimes(1);
  expect(resolvePublicReport).toHaveBeenCalledWith("one-view-token");
});
