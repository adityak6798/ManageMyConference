/**
 * Outbound webhooks in the console.
 *
 * Beside API clients under Integrations, because the two answer the same question from opposite
 * directions: an API client is how something else reads Greenroom, a webhook is how Greenroom
 * tells something else. Both are organization-scoped machine credentials with a one-time secret.
 *
 * Gated on `communications:manage`, which is what all seven routes require — listing included.
 *
 * @spec PRD-INT-001
 */
import { WebhooksWorkspace } from "../WebhooksWorkspace";
import { IconSettings } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const webhooksWorkspace: WorkspaceModule = {
  domain: "communications-integrations",
  path: "/integrations/webhooks",
  label: "Webhooks",
  group: "Audience",
  /** Directly after API clients, the other half of the integrations pair. */
  order: 5.9,
  icon: <IconSettings size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("communications:manage") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Integrations",
    title: "Webhooks",
    subtitle:
      "Send events to your own systems as they happen, and see every delivery attempt they made.",
  }),
  render: ({ event }) => (
    <WebhooksWorkspace key={event.organizationId} organizationId={event.organizationId} />
  ),
};
