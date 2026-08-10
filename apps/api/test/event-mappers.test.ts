// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { eventToRow, rowToEvent } from "../src/adapters/persistence/event-mappers";
import { createEventInputToCommand, eventToDto } from "../src/transport/http/event-mappers";

describe("event boundary mappers", () => {
  it("maps transport, domain, and storage shapes explicitly", () => {
    const command = createEventInputToCommand({ name: "Summit", timezone: "UTC" });
    const event = {
      ...command,
      id: "123e4567-e89b-12d3-a456-426614174000",
      createdAt: "2026-08-09T12:00:00.000Z",
    };
    expect(rowToEvent(eventToRow(event))).toEqual(event);
    expect(eventToDto(event)).toEqual(event);
  });
});
