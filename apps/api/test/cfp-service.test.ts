// @acceptance ACC-CFP
import { describe, expect, it } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import {
  CfpService,
  CfpUnavailableError,
  CfpValidationError,
} from "../src/application/cfp/cfp-service";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const actor: Actor = {
  id: "organizer",
  name: "O",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(),
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set() }],
};
const fields = [
  {
    id: "title",
    type: "short_text" as const,
    label: "Talk title",
    guidance: "Be concise",
    required: true,
    options: [],
  },
  {
    id: "email",
    type: "email" as const,
    label: "Email",
    guidance: "",
    required: true,
    options: [],
  },
];
describe("CFP service", () => {
  it("supports draft, publish, close, and reopen", async () => {
    const service = new CfpService(
      new MemoryCfpRepository(),
      crypto.randomUUID,
      () => new Date("2026-08-10T12:00:00Z"),
    );
    expect(
      (await service.save(actor, { eventId, title: "Speak", description: "Join us", fields }))
        .status,
    ).toBe("draft");
    expect((await service.changeState(actor, eventId, "publish")).status).toBe("open");
    expect((await service.changeState(actor, eventId, "close")).status).toBe("closed");
    expect((await service.changeState(actor, eventId, "reopen")).status).toBe("open");
  });
  it("validates fields and makes retries idempotent", async () => {
    let sequence = 0;
    const service = new CfpService(
      new MemoryCfpRepository(),
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      () => new Date("2026-08-10T12:00:00Z"),
    );
    await service.save(actor, { eventId, title: "Speak", description: "", fields });
    await service.changeState(actor, eventId, "publish");
    await expect(
      service.submit(eventId, "retry-key", { title: "", email: "bad" }),
    ).rejects.toBeInstanceOf(CfpValidationError);
    const first = await service.submit(eventId, "retry-key-1", {
      title: "Typed forms",
      email: "a@example.com",
    });
    const retry = await service.submit(eventId, "retry-key-1", {
      title: "Changed",
      email: "b@example.com",
    });
    expect(retry).toEqual(first);
  });
  it("does not expose drafts and rejects cross-event organizers", async () => {
    const service = new CfpService(new MemoryCfpRepository(), crypto.randomUUID, () => new Date());
    await service.save(actor, { eventId, title: "Speak", description: "", fields });
    await expect(service.getPublished(eventId)).rejects.toBeInstanceOf(CfpUnavailableError);
    await expect(
      service.getForOrganizer(actor, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow("Organizer event access denied");
  });
});
