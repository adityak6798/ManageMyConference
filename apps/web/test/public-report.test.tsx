// @acceptance ACC-OPS
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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

afterEach(cleanup);

/*
 * The API refuses an unknown token, a revoked one, an expired one and a password-protected one
 * with the same sentence, on purpose: telling them apart would say whether a guessed token named
 * a real report. The most likely of the four on a link somebody was *given* is the password — so
 * the first refusal is the expected state of a protected link, and reporting it as a red failure
 * told the reader they had done something wrong by opening it.
 */
it("asks for the password as a neutral state, and reports a failure only once one was tried", async () => {
  // Its own token: the first resolve is memoised per token so StrictMode cannot spend two views
  // of a one-view link, and that cache outlives a test.
  window.history.replaceState({}, "", "/reports/protected-token");
  resolvePublicReport.mockRejectedValue(new Error("That link is not available."));

  render(<PublicReportApp />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "This report needs a password" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Open report" }));

  // Now it is news: the reader answered and the answer did not work.
  expect(await screen.findByRole("alert")).toHaveTextContent("That report link is not available.");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { level: 1, name: "That did not open the report" }),
    ).toBeVisible(),
  );
  expect(resolvePublicReport).toHaveBeenLastCalledWith("protected-token", "wrong");
});
