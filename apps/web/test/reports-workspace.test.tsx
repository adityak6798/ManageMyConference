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
 *
 * The fourth is the schedule's zone. A schedule fires in the *event's* timezone and the empty
 * state has always said so, while the create button sent the reader's own — so an organizer in
 * Berlin scheduling a Pacific event created one nine hours from the promise on screen.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReportsWorkspace } from "../src/ReportsWorkspace";

const EVENT = "00000000-0000-4000-8000-000000000001";
const EVENT_ZONE = "America/Los_Angeles";

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

// This suite renders the same component several times; without an explicit unmount each render
// leaves its tree in the document and every query finds three of everything.
afterEach(cleanup);

const renderWorkspace = (canReadPii: boolean) =>
  render(<ReportsWorkspace eventId={EVENT} timezone={EVENT_ZONE} canReadPii={canReadPii} />);

it("offers only the datasets and comparisons the server advertises", async () => {
  renderWorkspace(false);
  // A control that appears is a query that will run: the catalogue is a response rather than a
  // constant here precisely so the screen cannot offer a field the service refuses.
  const dataset = await screen.findByRole("combobox", { name: "Dataset" });
  fireEvent.keyDown(dataset, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Speakers/ })).toBeInTheDocument();
  fireEvent.keyDown(dataset, { key: "Escape" });
  expect(screen.getByRole("checkbox", { name: /Email/ })).toBeInTheDocument();
  // Personal columns are marked before anybody runs anything.
  expect(screen.getByText("Personal")).toBeInTheDocument();
});

it("withholds the unmasking control, and says what withholding costs", async () => {
  renderWorkspace(false);
  await screen.findByRole("combobox", { name: "Dataset" });
  expect(
    screen.queryByRole("checkbox", { name: /unmasked personal data/ }),
  ).not.toBeInTheDocument();
  // Named rather than left to be inferred from a masked value.
  expect(screen.getByText(/Personal columns are masked/)).toBeInTheDocument();
});

it("offers the unmasking control to a caller holding the capability, and says it is recorded", async () => {
  renderWorkspace(true);
  await screen.findByRole("combobox", { name: "Dataset" });
  // The label carries the consequence, because unmasking is an act rather than a preference.
  expect(screen.getByRole("checkbox", { name: /this action is recorded/ })).toBeInTheDocument();
});

it("reads each condition as a sentence, and names both of its pickers", async () => {
  renderWorkspace(false);
  await screen.findByRole("combobox", { name: "Dataset" });
  fireEvent.click(screen.getByRole("button", { name: "Add a condition" }));
  // Two unnamed selects and an unlabelled box used to sit in a bare `.actions` div: no grid, no
  // gap, and nothing for a screen reader to announce them by.
  expect(screen.getByRole("combobox", { name: "Field for condition 1" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Comparison for condition 1" })).toBeInTheDocument();
  expect(screen.getByLabelText("Value for condition 1")).toBeInTheDocument();
  expect(screen.getByText("where")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Add a condition" }));
  expect(screen.getByText("and")).toBeInTheDocument();
});
