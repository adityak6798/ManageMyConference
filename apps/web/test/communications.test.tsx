// @acceptance ACC-INTEGRATION
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const secondEventId = "00000000-0000-4000-8000-000000000002";

describe("communications history", () => {
  beforeEach(() => {
    // The outbox is its own route now and loads its history on mount.
    window.history.replaceState(null, "", "/communications");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
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
                eventAccess: [eventId, secondEventId].map((assignedEventId) => ({
                  eventId: assignedEventId,
                  role: "organizer",
                  capabilities: ["events:read"],
                })),
                capabilities: ["events:read", "communications:manage"],
              }),
            ),
          );
        if (url.endsWith("/api/events/assigned"))
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
                  {
                    id: secondEventId,
                    organizationId,
                    name: "Workshop",
                    timezone: "UTC",
                    createdAt: "2026-08-11T12:00:00.000Z",
                  },
                ],
              }),
            ),
          );
        if (url.includes("/api/communications/history"))
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
                nextCursor: null,
              }),
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "NOT_FOUND",
                message: "No fixture for this domain.",
                correlationId: "fixture-other-domain",
              },
            }),
            { status: 404 },
          ),
        );
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "Refresh outbox" });
    expect(await screen.findByText("terminal", { exact: true })).toBeInTheDocument();
    // Attempt history is collapsed by default; open it before asserting the failure.
    fireEvent.click(screen.getByRole("button", { name: /attempt history for session:42/ }));
    expect(
      await screen.findByText(/Attempt 1: terminal_failure — PROVIDER_REJECTED/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry session:42" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Event workspace" }), {
      target: { value: secondEventId },
    });
    expect(screen.queryByText("terminal", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry session:42" })).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)(
    "discards a deferred history %s after the organizer switches events",
    async (outcome) => {
      let resolveHistory: (response: Response) => void = () => undefined;
      let rejectHistory: (reason: Error) => void = () => undefined;
      const deferredHistory = new Promise<Response>((resolve, reject) => {
        resolveHistory = resolve;
        rejectHistory = reject;
      });
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
                  eventAccess: [eventId, secondEventId].map((assignedEventId) => ({
                    eventId: assignedEventId,
                    role: "organizer",
                    capabilities: ["events:read"],
                  })),
                  capabilities: ["events:read", "communications:manage"],
                }),
              ),
            );
          if (url.endsWith("/api/events/assigned"))
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
                    {
                      id: secondEventId,
                      organizationId,
                      name: "Workshop",
                      timezone: "UTC",
                      createdAt: "2026-08-11T12:00:00.000Z",
                    },
                  ],
                }),
              ),
            );
          // Only the first event's history is deferred; the second resolves at once
          // and empty, so anything from the first event that lands afterwards is
          // unambiguously stale and must be discarded.
          if (url.includes("/api/communications/history")) {
            if (url.includes(`eventId=${eventId}`)) return deferredHistory;
            return Promise.resolve(new Response(JSON.stringify({ history: [], nextCursor: null })));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "NOT_FOUND",
                  message: "No fixture for this domain.",
                  correlationId: "fixture-other-domain",
                },
              }),
              { status: 404 },
            ),
          );
        }),
      );
      render(<App />);
      await screen.findByRole("button", { name: "Refresh outbox" });
      fireEvent.change(screen.getByRole("combobox", { name: "Event workspace" }), {
        target: { value: secondEventId },
      });
      if (outcome === "success")
        resolveHistory(
          new Response(
            JSON.stringify({
              history: [
                {
                  delivery: {
                    id: "stale-terminal",
                    organizationId,
                    eventId,
                    idempotencyKey: "stale",
                    triggerType: "projection.requested",
                    channel: "airtable",
                    templateId: null,
                    templateVersion: null,
                    recipientRef: "session:stale",
                    payload: {},
                    projectionVersion: 1,
                    state: "terminal",
                    attemptCount: 1,
                    nextAttemptAt: "2026-08-10T12:00:01.000Z",
                    leaseToken: null,
                    createdAt: "2026-08-10T12:00:00.000Z",
                    updatedAt: "2026-08-10T12:00:01.000Z",
                  },
                  attempts: [],
                },
              ],
              nextCursor: null,
            }),
          ),
        );
      else rejectHistory(new Error("event A unavailable"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Refresh outbox" })).toBeEnabled(),
      );
      expect(screen.queryByText("session:stale")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("discards a deferred retry failure after the organizer switches events", async () => {
    let rejectRetry: (reason: Error) => void = () => undefined;
    const deferredRetry = new Promise<Response>((_resolve, reject) => {
      rejectRetry = reject;
    });
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
                eventAccess: [eventId, secondEventId].map((assignedEventId) => ({
                  eventId: assignedEventId,
                  role: "organizer",
                  capabilities: ["events:read"],
                })),
                capabilities: ["events:read", "communications:manage"],
              }),
            ),
          );
        if (url.endsWith("/api/events/assigned"))
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
                  {
                    id: secondEventId,
                    organizationId,
                    name: "Workshop",
                    timezone: "UTC",
                    createdAt: "2026-08-11T12:00:00.000Z",
                  },
                ],
              }),
            ),
          );
        if (url.includes("/retry")) return deferredRetry;
        if (url.includes("/api/communications/history"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                history: [
                  {
                    delivery: {
                      id: "terminal-retry",
                      organizationId,
                      eventId,
                      idempotencyKey: "retry",
                      triggerType: "projection.requested",
                      channel: "airtable",
                      templateId: null,
                      templateVersion: null,
                      recipientRef: "session:retry",
                      payload: {},
                      projectionVersion: 1,
                      state: "terminal",
                      attemptCount: 1,
                      nextAttemptAt: "2026-08-10T12:00:01.000Z",
                      leaseToken: null,
                      createdAt: "2026-08-10T12:00:00.000Z",
                      updatedAt: "2026-08-10T12:00:01.000Z",
                    },
                    attempts: [],
                  },
                ],
                nextCursor: null,
              }),
            ),
          );
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "Refresh outbox" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry session:retry" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Event workspace" }), {
      target: { value: secondEventId },
    });
    rejectRetry(new Error("event A retry unavailable"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh outbox" })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
