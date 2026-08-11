// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

// The visitor's own zone must never leak into the published times: everything is
// rendered in the event's zone, and the browser here is deliberately elsewhere.
test.use({ timezoneId: "Asia/Tokyo" });

test("browses the same accessible published projection directly and embedded", async ({ page }) => {
  await page.goto("/events/greenroom-demo-summit");
  await expect(
    page.getByRole("heading", { level: 1, name: "Greenroom Demo Summit" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Greenroom Demo Summit");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /practical gathering/,
  );

  // The home page carries the event itself — dates, venue, itinerary, gallery, CFP —
  // rather than a hero with nothing behind it.
  await expect(page.getByText("September 17–18, 2026").first()).toBeVisible();
  await expect(page.getByText("Harbor Conference Center, Oakland").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule at a glance" })).toBeVisible();
  await expect(
    page.locator(".pub-glance").getByRole("link", { name: "Calm systems for busy event teams" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speakers", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Maya Chen" })).toBeVisible();
  await expect(page.getByText("Community systems designer")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Share what you learned" })).toBeVisible();
  await expect(page.locator(".pub-cta a[href$='/cfp']")).toBeVisible();
  // No headshot is served yet, so the gallery draws initials rather than a gap.
  await expect(page.locator(".pub-speaker .pub-avatar").first()).toHaveText("MC");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Schedule", exact: true })).toBeFocused();
  // A marker on window survives client-side navigation but not a document load.
  await page.evaluate(() => Reflect.set(window, "greenroomNavProbe", "same-document"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Plan your time" })).toBeVisible();
  await expect(page).toHaveURL(/\/events\/greenroom-demo-summit\/schedule$/);
  await expect(page).toHaveTitle("Schedule · Greenroom Demo Summit");
  expect(await page.evaluate(() => Reflect.get(window, "greenroomNavProbe"))).toBe("same-document");

  // The zone is stated once for the whole itinerary, not on every card.
  await expect(page.locator(".pub-tz")).toHaveCount(1);
  await expect(page.locator(".pub-tz")).toContainText("All times in America/Los_Angeles (PDT)");
  await expect(page.getByRole("heading", { name: "Thursday, September 17" })).toBeVisible();
  await expect(page.getByText("10:00 AM", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Cedar Hall")).toBeVisible();

  await page.getByRole("link", { name: "Calm systems for busy event teams" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Calm systems for busy event teams" }),
  ).toBeVisible();
  await expect(page.locator(".pub-tz")).toContainText(
    "Thursday, September 17, 2026 at 10:00 AM PDT",
  );
  await page.getByRole("link", { name: "← All sessions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();

  // Sessions can be narrowed without a round trip; the count is announced.
  await page.getByLabel("Search sessions").fill("accessible");
  await expect(page.getByRole("status")).toContainText("Showing 1 of 2 sessions");
  await expect(page.getByRole("link", { name: "Accessible by default" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Calm systems for busy event teams" })).toHaveCount(
    0,
  );

  // Gallery: every speaker card carries a headshot tile, a role, and their sessions.
  await page.getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  await expect(page.locator(".pub-speaker")).toHaveCount(2);
  await expect(page.locator(".pub-speaker .pub-avatar")).toHaveText(["MC", "JB"]);
  const jordan = page.locator(".pub-speaker").filter({ hasText: "Jordan Bell" });
  await expect(jordan.getByText("Accessibility lead")).toBeVisible();
  await expect(jordan.getByRole("link", { name: "Accessible by default" })).toBeVisible();
  await jordan.getByRole("link", { name: "Jordan Bell" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Jordan Bell" })).toBeVisible();
  await expect(page).toHaveTitle("Jordan Bell · Greenroom Demo Summit");

  // Back and forward have to re-render, not strand the visitor on a stale view.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Jordan Bell" })).toBeVisible();

  // Embeds ship the content only: the host page keeps its own nav and footer.
  await page.goto("/embed/events/greenroom-demo-summit/schedule");
  await expect(page.getByRole("heading", { level: 1, name: "Plan your time" })).toBeVisible();
  await expect(page.getByText("Calm systems for busy event teams")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.locator("main")).toHaveCount(1);
  // The only way out of the frame opens the real site in a new tab.
  await expect(page.getByRole("link", { name: /Greenroom Demo Summit/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByRole("link", { name: /Open the full event site/ })).toHaveAttribute(
    "href",
    "/events/greenroom-demo-summit/schedule",
  );

  await page.goto("/embed/events/greenroom-demo-summit/speakers");
  await expect(page.locator(".pub-speaker")).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  expect(await page.locator("img:not([alt])").count()).toBe(0);
  expect(
    await page
      .locator("[id]")
      .evaluateAll((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length),
  ).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    "/events/greenroom-demo-summit",
    "/events/greenroom-demo-summit/schedule",
    "/events/greenroom-demo-summit/speakers",
    "/embed/events/greenroom-demo-summit/schedule",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }

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
