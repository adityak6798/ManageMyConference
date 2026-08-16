// @acceptance ACC-INTEGRATION
/*
 * The organizer surface for the Accelevents registration sync.
 *
 * Before #58 the feature had no surface at all, so these assertions are about what an organizer
 * can now see and decide: what a run would do before it does it, whether the numbers came from
 * their registration platform or from the fixture roster, and what happened when it failed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccelEventsSync } from "../src/content/AccelEventsSync";

const eventId = "00000000-0000-4000-8000-000000000001";

const report = {
  preview: true,
  total: 3,
  created: 2,
  skipped: 0,
  invalid: 1,
  rows: [
    {
      sourceRef: "ae-1",
      name: "Nadia Okafor",
      email: "nadia@example.test",
      disposition: "create",
      errors: [],
    },
    {
      sourceRef: "ae-2",
      name: "Sam Speaker",
      email: "sam@example.test",
      disposition: "create",
      errors: [],
    },
    {
      sourceRef: "ae-3",
      name: "Broken Record",
      email: "no-email@",
      disposition: "invalid",
      errors: ["Valid email is required"],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `run` as the workspace supplies it: awaits the action and reports only success or failure. */
const run = async (action: () => Promise<unknown>) => {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    // ERROR-INTENT: this mirrors the workspace's own runner, whose contract is to convert a
    // rejection into a reported failure rather than to let it escape a click handler.
    return { ok: false as const, error };
  }
};

function mount(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
  return render(<AccelEventsSync eventId={eventId} busy={false} run={run} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Accelevents organizer surface", () => {
  it("explains that demo previews do not contact Accelevents", async () => {
    mount(async () => json({ mode: "fixture", direction: "inbound", lastRun: null }));

    // An organizer reading "2 imported" has to be able to tell whether their registration
    // platform was contacted at all. Saying nothing would be the misleading answer.
    expect(await screen.findByText(/Demo mode/)).toHaveTextContent("does not contact Accelevents");
    expect(screen.getByText(/never been applied/)).toBeTruthy();
  });

  it("previews without importing, and only then offers the import", async () => {
    const calls: { url: string; body: unknown }[] = [];
    mount(async (url, init) => {
      if (!init?.method) return json({ mode: "live", direction: "inbound", lastRun: null });
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return json(report);
    });

    await screen.findByText(/Reading the live Accelevents/);
    // Import is unreachable until a preview has been seen: nothing writes from a surface the
    // organizer has not first been shown the consequences on.
    expect(
      screen.getByRole("button", { name: "Import registrants" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview registrations" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ commit: false });
    expect(await screen.findByText(/Preview — nothing written/)).toBeTruthy();
    // Every row is accounted for, and the one that cannot be imported says why.
    expect(
      screen.getByText(/Broken Record · no-email@ · Not imported — Valid email is required/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Import registrants" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reports the last run's failure rather than leaving it in a console", async () => {
    mount(async () =>
      json({
        mode: "live",
        direction: "inbound",
        lastRun: {
          eventId,
          startedAt: "2026-08-12T09:00:00.000Z",
          completedAt: "2026-08-12T09:00:01.000Z",
          outcome: "failed",
          total: 0,
          created: 0,
          skipped: 0,
          invalid: 0,
          errorCode: "PROVIDER_UNAVAILABLE:503",
        },
      }),
    );

    // The normalized code is what an operator acts on, and it is the whole of what we show —
    // never the provider's own message, which can echo a credential back.
    expect(await screen.findByText(/failed \(PROVIDER_UNAVAILABLE:503\)/)).toBeTruthy();
  });

  it("says the platform could not be read when a preview fails", async () => {
    mount(async (_url, init) => {
      if (!init?.method) return json({ mode: "live", direction: "inbound", lastRun: null });
      return json(
        {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "unreadable",
            correlationId: "corr-1",
          },
        },
        502,
      );
    });

    await screen.findByText(/Reading the live Accelevents/);
    fireEvent.click(screen.getByRole("button", { name: "Preview registrations" }));

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    // Nothing invented: a failed preview shows no row table at all.
    expect(screen.queryByText(/registrants ·/)).toBeNull();
  });
});
