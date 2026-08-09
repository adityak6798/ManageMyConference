// @acceptance ACC-HARNESS
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads and displays persisted events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            events: [
              {
                id: "123e4567-e89b-12d3-a456-426614174000",
                name: "Greenroom Summit",
                timezone: "America/Los_Angeles",
                createdAt: "2026-08-09T12:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText("Greenroom Summit")).toBeInTheDocument());
  });

  it("shows a safe error and correlation reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "UNAUTHORIZED",
              message: "Organizer authentication is required.",
              correlationId: "trace-123",
            },
          }),
          { status: 401 },
        ),
      ),
    );

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: trace-123");
  });

  it("shows a correlation-linked create failure after sign-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "UNAUTHORIZED",
              message: "Sign in to continue.",
              correlationId: "initial-trace",
            },
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ persona: "organizer" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "The event could not be created.",
              correlationId: "create-trace",
            },
          }),
          { status: 500 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByText("Reference: initial-trace", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Continue as demo organizer" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create event" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "Broken Summit" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: create-trace");
  });
});
