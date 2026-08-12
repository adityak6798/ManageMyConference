import { describe, expect, it } from "vitest";
import {
  type Actor,
  CapabilityDeniedError,
  requireEventCapability,
} from "../src/application/identity/actor";

const actor: Actor = {
  id: "mixed-role",
  name: "Mixed Role",
  persona: "organizer",
  organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
  capabilities: new Set(["crm:manage", "review:evaluate"]),
  eventAccess: [
    {
      eventId: "00000000-0000-4000-8000-000000000001",
      role: "organizer",
      capabilities: new Set(["crm:manage"]),
    },
    {
      eventId: "00000000-0000-4000-8000-000000000002",
      role: "reviewer",
      capabilities: new Set(["review:evaluate"]),
    },
  ],
};

describe("event capability contract", () => {
  it("accepts a capability on the exact event even when another role is listed first", () => {
    expect(
      requireEventCapability(actor, "00000000-0000-4000-8000-000000000002", "review:evaluate"),
    ).toBe(actor);
  });

  it("does not let an actor-wide union grant cross-event access to a known event", () => {
    expect(() =>
      requireEventCapability(actor, "00000000-0000-4000-8000-000000000002", "crm:manage"),
    ).toThrow(CapabilityDeniedError);
  });

  it("denies an event in another organization even when the actor-wide capability exists", () => {
    expect(() =>
      requireEventCapability(actor, "00000000-0000-4000-8000-000000000099", "crm:manage"),
    ).toThrow(CapabilityDeniedError);
  });
});
