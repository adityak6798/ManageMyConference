// @acceptance ACC-IDENTITY-EVENTS
/**
 * The console half of the per-event portal lock — the primitive issue #189's `GAP-028` residual
 * consumes, and the reason a speaker portal's write surface no longer has to be fixed in code.
 *
 * Two properties are asserted because getting either wrong is silent.
 *
 * **A save sends the whole set**, not the field that changed. The route replaces, so a partial
 * body would read as "the organizer opened everything else" — and nothing would say so.
 *
 * **A required field is not offered a Hide.** The service refuses it, and a control that offers a
 * refusal teaches people the screen is lying rather than that the field is required.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setEventFieldLocks } from "../src/api/custom-roles";
import { CustomRolesWorkspace } from "../src/CustomRolesWorkspace";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a1";
const EVENT = "00000000-0000-4000-8000-000000000001";

const roles = {
  roles: [],
  assignments: [],
  templates: [],
  grantableCapabilities: [],
  fieldLocks: [{ subject: "speaker" as const, field: "biography", policy: "lock" as const }],
  catalogue: [
    {
      subject: "speaker" as const,
      fields: [
        { field: "name", required: true },
        { field: "biography", required: false },
        { field: "photoUrl", required: false },
      ],
    },
  ],
};

vi.mock("../src/api/custom-roles", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api/custom-roles")>("../src/api/custom-roles");
  return {
    ...actual,
    listCustomRoles: vi.fn(async () => roles),
    setEventFieldLocks: vi.fn(async () => ({ locks: [] })),
  };
});

vi.mock("../src/api/membership", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api/membership")>("../src/api/membership");
  return { ...actual, listMembers: vi.fn(async () => ({ members: [] })) };
});

afterEach(cleanup);

it("saves the whole lock set, not the field that changed", async () => {
  render(<CustomRolesWorkspace organizationId={ORGANIZATION} eventId={EVENT} canManage={true} />);
  // The stored lock is what the screen shows before anybody touches it.
  const biography = await screen.findByRole("combobox", { name: "Biography" });
  expect((biography as HTMLSelectElement).value).toBe("lock");

  fireEvent.change(screen.getByRole("combobox", { name: "photoUrl" }), {
    target: { value: "hide" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save portal locks" }));

  expect(vi.mocked(setEventFieldLocks)).toHaveBeenCalledWith(
    ORGANIZATION,
    EVENT,
    expect.arrayContaining([
      { subject: "speaker", field: "biography", policy: "lock" },
      { subject: "speaker", field: "photoUrl", policy: "hide" },
    ]),
  );
  expect(vi.mocked(setEventFieldLocks).mock.calls[0]?.[2]).toHaveLength(2);
});

it("does not offer to hide a field the record cannot be identified without", async () => {
  render(<CustomRolesWorkspace organizationId={ORGANIZATION} eventId={EVENT} canManage={true} />);
  const name = await screen.findByRole("combobox", { name: "Name" });

  expect([...(name as HTMLSelectElement).options].map((option) => option.value)).toEqual([
    "view",
    "lock",
  ]);
});
