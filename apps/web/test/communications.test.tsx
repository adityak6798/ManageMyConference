// @acceptance ACC-INTEGRATION
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";

describe("communications history", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows observable states and an explicit terminal recovery action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                actor: { id: "seed-organizer", name: "Olivia Organizer", persona: "organizer" },
                organizations: [{ id: organizationId }],
                eventAccess: [{ eventId, role: "organizer", capabilities: ["events:read"] }],
                capabilities: ["events:read", "communications:manage"],
              }),
            ),
          );
        if (url.endsWith("/api/events"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                events: [
                  {
                    id: eventId,
                    organizationId,
                    name: "Summit",
                    timezone: "UTC",
                    createdAt: "2026-08-10T12:00:00.000Z",
                  },
                ],
              }),
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              history: [
                {
                  delivery: {
                    id: "terminal-1",
                    organizationId,
                    eventId,
                    idempotencyKey: "terminal",
                    triggerType: "projection.requested",
                    channel: "airtable",
                    templateId: null,
                    templateVersion: null,
                    recipientRef: "session:42",
                    payload: {},
                    projectionVersion: 1,
                    state: "terminal",
                    attemptCount: 1,
                    nextAttemptAt: "2026-08-10T12:00:01.000Z",
                    leaseToken: null,
                    createdAt: "2026-08-10T12:00:00.000Z",
                    updatedAt: "2026-08-10T12:00:01.000Z",
                  },
                  attempts: [
                    {
                      id: "attempt-1",
                      deliveryId: "terminal-1",
                      sequence: 1,
                      startedAt: "2026-08-10T12:00:00.000Z",
                      completedAt: "2026-08-10T12:00:01.000Z",
                      outcome: "terminal_failure",
                      providerReference: null,
                      errorCode: "PROVIDER_REJECTED",
                    },
                  ],
                },
              ],
            }),
          ),
        );
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect delivery history" }));
    expect(await screen.findByText("terminal", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry session:42" })).toBeEnabled();
  });
});
