// @acceptance ACC-OPS
/**
 * What the reports screen tells somebody about data it is not showing them.
 *
 * The two assertions here are the ones the issue's PII outcome rests on. A masked column has to be
 * *named*, because a masked value on its own reads as the record's contents; and a dataset the
 * caller's role cannot open has to say so, because an empty table reads as "there is nothing"
 * rather than "this is not yours".
 *
 * The unmasking control is the third: it is absent without the capability, which is a courtesy
 * rather than a defence — the API refuses `includePii` on the same terms regardless, and
 * `reporting.test.ts` asserts that half.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReportsWorkspace } from "../src/ReportsWorkspace";

const EVENT = "00000000-0000-4000-8000-000000000001";

const catalogue = {
  datasets: [
    {
      key: "speakers" as const,
      label: "Speakers",
      source: "content",
      fields: [
        { key: "name", label: "Name", type: "text" as const },
        { key: "email", label: "Email", type: "text" as const, pii: true },
      ],
    },
  ],
  operators: ["equals" as const, "contains" as const],
};

vi.mock("../src/api/reports", async () => {
  const actual = await vi.importActual<typeof import("../src/api/reports")>("../src/api/reports");
  return {
    ...actual,
    readReportCatalogue: vi.fn(async () => catalogue),
    listReports: vi.fn(async () => ({ reports: [] })),
  };
});

// This suite renders the same component three times; without an explicit unmount each render
// leaves its tree in the document and every query finds three of everything.
afterEach(cleanup);

it("offers only the datasets and comparisons the server advertises", async () => {
  render(<ReportsWorkspace eventId={EVENT} canReadPii={false} />);
  // A control that appears is a query that will run: the catalogue is a response rather than a
  // constant here precisely so the screen cannot offer a field the service refuses.
  expect(await screen.findByRole("option", { name: "Speakers" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Email/ })).toBeInTheDocument();
  // Personal columns are marked before anybody runs anything.
  expect(screen.getByText("Personal")).toBeInTheDocument();
});

it("withholds the unmasking control, and says what withholding costs", async () => {
  render(<ReportsWorkspace eventId={EVENT} canReadPii={false} />);
  await screen.findByRole("option", { name: "Speakers" });
  expect(
    screen.queryByRole("checkbox", { name: /Show personal data unmasked/ }),
  ).not.toBeInTheDocument();
  // Named rather than left to be inferred from a masked value.
  expect(screen.getByText(/Personal columns are masked/)).toBeInTheDocument();
});

it("offers the unmasking control to a caller holding the capability, and says it is recorded", async () => {
  render(<ReportsWorkspace eventId={EVENT} canReadPii={true} />);
  await screen.findByRole("option", { name: "Speakers" });
  // The label carries the consequence, because unmasking is an act rather than a preference.
  expect(screen.getByRole("checkbox", { name: /this action is recorded/ })).toBeInTheDocument();
});
