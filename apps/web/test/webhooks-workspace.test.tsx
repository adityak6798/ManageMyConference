// @acceptance ACC-INTEGRATION
/**
 * What the webhooks screen has to say out loud.
 *
 * This surface exists because seven working routes had no caller at all, so the assertions here
 * are about the two facts a person cannot recover once they are gone.
 *
 * **The signing secret is shown once**, on creation, and nothing can reissue it. If the screen
 * renders it without saying that, somebody closes the tab and the subscription is unusable.
 *
 * **Rotation overlaps**, and the instant the old secret stops verifying is the deadline a receiver
 * has to deploy by. Printing the new secret without printing that instant turns a safe rotation
 * into an outage nobody scheduled.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { listWebhooks, WebhookApiError } from "../src/api/webhooks";
import { WebhooksWorkspace } from "../src/WebhooksWorkspace";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a1";

const subscription = {
  id: "sub_1",
  organizationId: ORGANIZATION,
  eventId: null,
  url: "https://example.test/hooks/greenroom",
  eventTypes: ["schedule.published" as const],
  state: "active" as const,
  createdAt: "2026-08-01T09:00:00.000Z",
  disabledAt: null,
  disabledReason: null,
};

vi.mock("../src/api/webhooks", async () => {
  const actual = await vi.importActual<typeof import("../src/api/webhooks")>("../src/api/webhooks");
  return {
    ...actual,
    listWebhooks: vi.fn(async () => ({ subscriptions: [subscription] })),
    rotateWebhookSecret: vi.fn(async () => ({
      secret: "whsec_ffffffffffffffffffffffffffffffff",
      overlapExpiresAt: "2026-08-02T09:00:00.000Z",
    })),
  };
});

afterEach(cleanup);

it("says the signing secret returned by rotation is the one to deploy, and by when", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findByText("https://example.test/hooks/greenroom");

  fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));

  await waitFor(() =>
    expect(screen.getByText("whsec_ffffffffffffffffffffffffffffffff")).toBeInTheDocument(),
  );
  // The overlap is the whole difference between rotating and breaking: the old secret keeps
  // verifying until this instant, and a receiver that never learns it has no deadline to work to.
  expect(screen.getByText(/keeps verifying until/)).toBeInTheDocument();
});

it("puts every route that had no caller on the screen", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findByText("https://example.test/hooks/greenroom");

  for (const control of ["Deliveries", "Rotate secret", "Remove", "Add webhook"])
    expect(screen.getByRole("button", { name: control })).toBeInTheDocument();
});

it("treats a deployment with no egress as unconfigured rather than as a failure", async () => {
  vi.mocked(listWebhooks).mockRejectedValueOnce(
    new WebhookApiError("corr-1", "Webhook delivery is not configured.", {}, "WEBHOOK_UNAVAILABLE"),
  );
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);

  expect(await screen.findByText("Webhook delivery is not configured here")).toBeInTheDocument();
  // Every local checkout answers this way, so an alert here would be the console's most-seen red
  // banner and would say nothing an organizer could act on.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
