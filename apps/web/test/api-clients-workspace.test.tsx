// @acceptance ACC-HARNESS
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

it("offers a keyboard-operable copy control for the one-time credential", async () => {
  render(
    <ApiClientsWorkspace
      organizationId="00000000-0000-4000-8000-000000000010"
      eventId="00000000-0000-4000-8000-000000000001"
      realSession
    />,
  );
  fireEvent.change(await screen.findByLabelText("Client name"), {
    target: { value: "Automation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create client" }));
  const copy = await screen.findByRole("button", { name: "Copy credential" });

  copy.focus();
  fireEvent.keyDown(copy, { key: "Enter" });
  fireEvent.click(copy);

  expect(copy).toHaveFocus();
  expect(writeText).toHaveBeenCalledWith(credential);
  expect(await screen.findByText("API credential copied to the clipboard.")).toBeVisible();
});
