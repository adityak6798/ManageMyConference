// @acceptance ACC-IDENTITY-EVENTS
import { expect, test } from "@playwright/test";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const EVENT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000100";
const CREDENTIAL = "grn_0123456789abcdef.abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

test("a real-session organizer creates a client and sees its credential only once", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  // The local browser fixture is deliberately demo-only and durable credential writes refuse
  // demo personas. Replace only the identity read with the same organizer as a real session;
  // event reads continue through the running Worker and its seeded D1 fixture.
  await page.route("**/api/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        actor: { id: "real-organizer", name: "Olivia Organizer", persona: "organizer" },
        organizations: [{ id: ORGANIZATION }],
        eventAccess: [
          {
            eventId: EVENT,
            role: "organizer",
            capabilities: ["events:read", "identity:manage"],
          },
        ],
        capabilities: ["events:read", "identity:manage"],
        authentication: "session",
      }),
    }),
  );

  let clients: unknown[] = [];
  await page.route(`**/api/organizations/${ORGANIZATION}/api-clients`, async (route) => {
    if (route.request().method() === "POST") {
      const client = {
        id: CLIENT,
        organizationId: ORGANIZATION,
        name: "Schedule exporter",
        keyPrefix: "0123456789abcdef", // gitleaks:allow — public deterministic prefix fixture.
        createdBy: "real-organizer",
        createdAt: "2026-08-13T12:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        scopes: ["events:read"],
        eventIds: [EVENT],
      };
      clients = [client];
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ client, credential: CREDENTIAL }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ clients }),
    });
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "API clients", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "API clients" })).toBeVisible();
  await page.getByLabel("Client name").fill("Schedule exporter");
  await page.getByRole("button", { name: "Create client" }).click();

  await expect(page.getByText("Copy this credential now. It is shown once.")).toBeVisible();
  await expect(page.getByText(CREDENTIAL, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "API clients" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Schedule exporter" })).toBeVisible();
  await expect(page.getByText(CREDENTIAL, { exact: true })).toHaveCount(0);
});
