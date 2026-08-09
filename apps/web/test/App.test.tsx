// @acceptance ACC-HARNESS
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

describe("App", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
