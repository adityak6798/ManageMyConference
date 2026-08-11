// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Tokyo" });

test("browses the same accessible published projection directly and embedded", async ({ page }) => {
  await page.goto("/events/greenroom-demo-summit");
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  await expect(page).toHaveTitle("Greenroom Demo Summit");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /practical gathering/,
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Schedule", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await expect(page).toHaveTitle("Schedule · Greenroom Demo Summit");
  await expect(page.getByText("Sep 17, 2026, 10:00 AM America/Los_Angeles")).toBeVisible();
  await page.getByRole("link", { name: "Calm systems for busy event teams" }).click();
  await expect(
    page.getByRole("heading", { name: "Calm systems for busy event teams" }),
  ).toBeVisible();
  await page.goto("/embed/events/greenroom-demo-summit/schedule");
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await expect(page.getByText("Calm systems for busy event teams")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await expect(page.locator("main")).toHaveCount(1);
  expect(await page.locator("img:not([alt])").count()).toBe(0);
  expect(
    await page
      .locator("[id]")
      .evaluateAll((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.goto("/events/greenroom-demo-summit/cfp");
  await page.getByLabel("Proposal title").fill("A public CFP submission");
  await page.getByLabel("Abstract").fill("Submitted from the public event route.");
  await page.getByLabel("Contact email").fill("public-speaker@example.com");
  if (await page.getByLabel("Experience level").count())
    await page.getByLabel("Experience level").selectOption("Experienced");
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("status")).toContainText(/Confirmation: [0-9a-f-]{36}/);
  await page.request.post("/api/demo-session", { data: { persona: "organizer" } });
  const closed = await page.request.post(
    "/api/events/00000000-0000-4000-8000-000000000001/cfp/state",
    { data: { state: "close" } },
  );
  expect(closed.ok()).toBeTruthy();
  await page.goto("/events/greenroom-demo-summit/cfp");
  await expect(page.getByText("Submissions closed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit proposal" })).toHaveCount(0);
});

test("shows a clear unpublished or unknown event state", async ({ page }) => {
  await page.goto("/events/not-published");
  await expect(page.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
});
