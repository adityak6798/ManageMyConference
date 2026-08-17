// @acceptance ACC-HARNESS
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiClientsWorkspace } from "../src/workspaces/api-clients";

const credential = "grn_0123456789abcdef.abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
const writeText = vi.fn();

vi.mock("../src/api/api-clients", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api/api-clients")>("../src/api/api-clients");
  return {
    ...actual,
    listApiClients: vi.fn(async () => ({ clients: [] })),
    createApiClient: vi.fn(async () => ({
      credential,
      client: {
        id: "00000000-0000-4000-8000-000000000100",
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Automation",
        keyPrefix: "0123456789abcdef", // gitleaks:allow — public deterministic prefix fixture.
        createdBy: "organizer",
        createdAt: "2026-08-13T12:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        scopes: ["events:read"],
        eventIds: ["00000000-0000-4000-8000-000000000001"],
      },
    })),
  };
});

// Two renders in one file: without an explicit unmount the first tree stays in the document
// and every query finds two of everything.
afterEach(cleanup);

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

const renderWorkspace = () =>
  render(
    <ApiClientsWorkspace
      organizationId="00000000-0000-4000-8000-000000000010"
      eventId="00000000-0000-4000-8000-000000000001"
      realSession
    />,
  );

it("offers a keyboard-operable copy control for the one-time credential", async () => {
  renderWorkspace();
  fireEvent.change(await screen.findByLabelText("Client name"), {
    target: { value: "Automation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create client" }));
  const copy = await screen.findByRole("button", { name: "Copy API credential" });

  copy.focus();
  fireEvent.keyDown(copy, { key: "Enter" });
  fireEvent.click(copy);

  expect(copy).toHaveFocus();
  expect(writeText).toHaveBeenCalledWith(credential);
  // The control says what happened where the pointer already is, rather than announcing it
  // somewhere else on a long form.
  expect(await screen.findByText("Copied")).toBeVisible();
});

it("asks what a capability lets the holder do, not what it is stored as", async () => {
  renderWorkspace();
  // `crm:manage` beside a tick box never said that private notes travel with the credential.
  const crm = await screen.findByRole("checkbox", { name: "Manage the speaker CRM" });
  expect(crm).toBeInTheDocument();
  expect(
    screen.getByText("Reads and edits every prospect, contact, and note in the pipeline."),
  ).toBeInTheDocument();
  // The one capability that carries personal data out of the product is marked as such.
  expect(screen.getByRole("checkbox", { name: /Read personal data unmasked/ })).toBeInTheDocument();
  expect(
    screen.getByText(
      "Reports return names, email addresses, and phone numbers with no masking, and export them.",
    ),
  ).toBeInTheDocument();
  // Grouped rather than presented as thirteen equivalent ticks.
  expect(screen.getByRole("heading", { name: "The programme" })).toBeInTheDocument();
});
