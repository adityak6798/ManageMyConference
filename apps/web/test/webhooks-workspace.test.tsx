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
import { createWebhook, deleteWebhook, listWebhooks, WebhookApiError } from "../src/api/webhooks";
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
    deleteWebhook: vi.fn(async () => undefined),
    createWebhook: vi.fn(async () => ({
      subscription: { ...subscription, id: "sub_2", url: "https://example.test/hooks/second" },
      secret: "whsec_22222222222222222222222222222222",
    })),
    rotateWebhookSecret: vi.fn(async () => ({
      secret: "whsec_ffffffffffffffffffffffffffffffff",
      overlapExpiresAt: "2026-08-02T09:00:00.000Z",
    })),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ENDPOINT = "https://example.test/hooks/greenroom";

it("says the signing secret returned by rotation is the one to deploy, and by when", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findAllByText(ENDPOINT);

  fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));

  await waitFor(() =>
    expect(screen.getByText("whsec_ffffffffffffffffffffffffffffffff")).toBeInTheDocument(),
  );
  // The overlap is the whole difference between rotating and breaking: the old secret keeps
  // verifying until this instant, and a receiver that never learns it has no deadline to work to.
  expect(screen.getByText(/keeps verifying until/)).toBeInTheDocument();
  // Shown once and unreissuable, so it gets a copy affordance rather than a bare <code> the
  // reader has to select by dragging — and it sits in the row of the endpoint it signs.
  expect(screen.getByRole("button", { name: "Copy Signing secret" })).toBeInTheDocument();
});

it("puts every route that had no caller on the screen", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findAllByText(ENDPOINT);

  // Each row-level control names the endpoint it acts on: three subscriptions otherwise give a
  // screen reader three identical "Remove" buttons.
  for (const control of [
    `Deliveries for ${ENDPOINT}`,
    "Rotate secret",
    `Remove ${ENDPOINT}`,
    "Add webhook",
  ])
    expect(screen.getByRole("button", { name: control })).toBeInTheDocument();
});

it("asks before removing a subscription, and names what stops", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findAllByText(ENDPOINT);

  fireEvent.click(screen.getByRole("button", { name: `Remove ${ENDPOINT}` }));

  // Removing drops every queued delivery and cannot reissue the secret, so the press asks first
  // rather than acting — it used to be a solid green primary flush against "Deliveries".
  expect(await screen.findByRole("heading", { name: "Remove this webhook?" })).toBeInTheDocument();
  expect(screen.getByText(/every delivery still queued for it is dropped/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove the webhook" })).toBeInTheDocument();
  expect(vi.mocked(deleteWebhook)).not.toHaveBeenCalled();
});

it("treats a deployment with no egress as unconfigured rather than as a failure", async () => {
  vi.mocked(listWebhooks).mockRejectedValueOnce(
    new WebhookApiError("corr-1", "Webhook delivery is not configured.", {}, "WEBHOOK_UNAVAILABLE"),
  );
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);

  expect(
    await screen.findByText("Webhooks are unavailable in this deployment"),
  ).toBeInTheDocument();
  // Every local checkout answers this way, so an alert here would be the console's most-seen red
  // banner and would say nothing an organizer could act on.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("holds back every control that would replace a signing secret nobody has stored yet", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findAllByText(ENDPOINT);

  fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
  await waitFor(() =>
    expect(screen.getByText("whsec_ffffffffffffffffffffffffffffffff")).toBeInTheDocument(),
  );

  // Creating an endpoint is the other half of the same one-time slot, and the form sits below the
  // table where the secret is: submitting it used to overwrite a rotation secret that exists
  // nowhere else, leaving the receiver on a secret whose overlap window had already been spent.
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: "https://example.test/hooks/second" },
  });
  expect(screen.getByRole("button", { name: "Add webhook" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Rotate secret" })).toBeDisabled();
  // A disabled control that does not say why reads as a broken one.
  expect(screen.getByText(/nothing can show it again/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));
  expect(vi.mocked(createWebhook)).not.toHaveBeenCalled();
  expect(screen.getByText("whsec_ffffffffffffffffffffffffffffffff")).toBeInTheDocument();

  // Acknowledging it is the only way past, and it releases both controls.
  fireEvent.click(screen.getByRole("button", { name: "I have stored it" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add webhook" })).not.toBeDisabled(),
  );
  expect(screen.getByRole("button", { name: "Rotate secret" })).not.toBeDisabled();
});

it("does not hold the screen for a secret it never managed to show", async () => {
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findAllByText(ENDPOINT);

  // The create succeeds and answers with the one-time secret, and the reload that would put the
  // new row on screen does not come back. Every route into the secret goes through that row, so
  // there is no secret on screen, no "I have stored it" to press, and nothing the sentence under
  // the form ("shown on the row above") can be pointing at.
  vi.mocked(listWebhooks).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: "https://example.test/hooks/second" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));

  await waitFor(() => expect(vi.mocked(createWebhook)).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByText("whsec_22222222222222222222222222222222")).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "I have stored it" })).toBeNull();

  // So the guard has to let go. Derived from `issued` alone it stayed on with no way to clear it:
  // both controls that issue a secret were inert for the rest of the session, and the reason
  // given for it was on a row that does not exist.
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: "https://example.test/hooks/third" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add webhook" })).not.toBeDisabled(),
  );
  expect(screen.getByRole("button", { name: "Rotate secret" })).not.toBeDisabled();
});

it("says the re-check failed rather than answering the press with an identical page", async () => {
  vi.mocked(listWebhooks).mockRejectedValueOnce(
    new WebhookApiError("corr-1", "Webhook delivery is not configured.", {}, "WEBHOOK_UNAVAILABLE"),
  );
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findByText("Webhooks are unavailable in this deployment");

  // A refresh over data already on screen keeps the page — but keeping the page is not the same
  // as keeping quiet. With the API unreachable the retry used to redraw the identical refusal,
  // so the only control on a dead-end screen answered a press with nothing at all.
  vi.mocked(listWebhooks).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("The webhook service did not answer.");
  // The deployment fact is still true and still the reason the screen refuses.
  expect(screen.getByText("Webhooks are unavailable in this deployment")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).not.toBeDisabled();
});

it("clears the failed-recheck notice once the deployment answers", async () => {
  vi.mocked(listWebhooks).mockRejectedValueOnce(
    new WebhookApiError("corr-1", "Webhook delivery is not configured.", {}, "WEBHOOK_UNAVAILABLE"),
  );
  render(<WebhooksWorkspace organizationId={ORGANIZATION} />);
  await screen.findByText("Webhooks are unavailable in this deployment");

  vi.mocked(listWebhooks).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));

  // Configuration is an operator action taken elsewhere, so the whole point of the button is that
  // it can succeed: a stale "we could not check" beside a screen that now works is a lie.
  await screen.findAllByText(ENDPOINT);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
