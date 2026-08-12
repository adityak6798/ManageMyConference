// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

/*
 * The public site, asserted against composed data only.
 *
 * Every string this file asserts is either something the run itself typed, or a value the
 * publishing composer derives from a row another domain owns — session titles from
 * `content_sessions`, speaker names and affiliations from `speaker_profiles`, room and
 * time from the published agenda, the event name from `events`. None of it is reachable
 * only through `public_event_projections`, which is what the seed used to be: a
 * hand-written blob naming sessions and speakers that existed nowhere else, so this suite
 * passed while compose→publish was broken. The last test proves the pipeline directly by
 * editing a session, publishing, and reading the edit back off the public page.
 */

// The visitor's own zone must never leak into the published times: everything is
// rendered in the event's zone, and the browser here is deliberately elsewhere.
// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({
  timezoneId: "Asia/Tokyo",
  extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.4" },
});

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SLUG = "greenroom-demo-summit";

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
  await expect(page.getByText("September 1, 2026").first()).toBeVisible();
  await expect(page.getByText("Harbor Conference Center, Oakland").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule at a glance" })).toBeVisible();
  await expect(
    page.locator(".pub-glance").getByRole("link", { name: "Designing the calm conference" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speakers", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Jordan Bell" })).toBeVisible();
  await expect(page.getByText("Northwind Access")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
  await expect(page.locator(".pub-cta a[href$='/cfp']")).toBeVisible();
  // Both avatar paths ship in the seed. Jordan's headshot is a publishable asset paired to
  // the profile the way `PUT /api/speaker-profiles/{profileId}/photo` pairs one — the seed
  // resolves it from Jordan's own image uploads rather than naming an id — so the gallery
  // renders a real image an anonymous visitor can actually fetch. Sam has no headshot until
  // a speaker chooses one, so that tile draws a monogram rather than leaving a gap; the
  // speaker portal journey uploads one, publishes it, and hands the demo back this way.
  const portrait = page
    .locator(".pub-speaker")
    .filter({ hasText: "Jordan Bell" })
    .locator(".pub-avatar");
  await expect(portrait).toHaveAttribute(
    "src",
    "/api/speaker-assets/90000000-0000-4000-8000-000000000001",
  );
  // The tile is lazy-loaded, so it has to be on screen before the bytes are demanded.
  await portrait.scrollIntoViewIfNeeded();
  await expect
    .poll(() => portrait.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(
    page.locator(".pub-speaker").filter({ hasText: "Sam Speaker" }).locator(".pub-avatar"),
  ).toHaveText("SS");

  await page.keyboard.press("Tab");
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
  await expect(page.getByRole("heading", { name: "Tuesday, September 1" })).toBeVisible();
  // The session starts at 16:00Z, which is 9:00 AM in the venue's zone and the next calendar
  // day in the browser's. The time is stated once, on the day rail, not repeated per card.
  await expect(page.getByText("9:00 AM", { exact: true })).toHaveCount(1);
  await expect(page.getByText("10:00 AM", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Main stage")).toBeVisible();

  await page.getByRole("link", { name: "Designing the calm conference" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Designing the calm conference" }),
  ).toBeVisible();
  await expect(page.locator(".pub-tz")).toContainText("Tuesday, September 1, 2026 at 9:00 AM PDT");
  await page.getByRole("link", { name: "← All sessions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();

  // Sessions can be narrowed without a round trip; the count is announced.
  await page.getByLabel("Search sessions").fill("accessible");
  await expect(page.getByRole("status")).toContainText("Showing 1 of 2 sessions");
  await expect(page.getByRole("link", { name: "Accessible by default" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Designing the calm conference" })).toHaveCount(0);

  // Gallery: every speaker card carries an avatar tile, an affiliation, and their sessions.
  await page.getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  await expect(page.locator(".pub-speaker")).toHaveCount(2);
  await expect(page.locator(".pub-speaker h3")).toHaveText(["Jordan Bell", "Sam Speaker"]);
  // One headshot, one monogram — the gallery never leaves a hole where a face belongs.
  await expect(page.locator(".pub-speaker img.pub-avatar")).toHaveCount(1);
  await expect(page.locator(".pub-speaker span.pub-avatar")).toHaveText(["SS"]);
  const jordan = page.locator(".pub-speaker").filter({ hasText: "Jordan Bell" });
  await expect(jordan.getByText("Northwind Access")).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Designing the calm conference" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.locator("main")).toHaveCount(1);
  // No brand link: an embed carries the content, not Greenroom's marketing chrome.
  await expect(page.getByRole("link", { name: /Greenroom Demo Summit/ })).toHaveCount(0);
  // The single way out of the frame opens the real site in a new tab.
  const exitLink = page.getByRole("link", { name: /Open the full event site/ });
  await expect(exitLink).toHaveAttribute("href", "/events/greenroom-demo-summit/schedule");
  await expect(exitLink).toHaveAttribute("target", "_blank");

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
    "/embed/events/greenroom-demo-summit/speakers",
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

  // Reopen it. A closed call for proposals is the state a judge would find the demo in
  // otherwise, and every later run of this journey would meet a form it cannot submit.
  const reopened = await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, {
    data: { state: "reopen" },
  });
  expect(reopened.ok(), `reopening the CFP failed: ${await reopened.text()}`).toBe(true);
  await page.goto("/events/greenroom-demo-summit/cfp");
  await expect(page.getByRole("button", { name: "Submit proposal" })).toBeVisible();
});

test("shows a clear unpublished or unknown event state", async ({ page }) => {
  await page.goto("/events/not-published");
  await expect(page.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
});

/**
 * The compose→publish→serve chain, end to end, on content this run edits.
 *
 * "Accessible by default" is the seeded session with no agenda placement, so renaming it
 * changes the sessions index and the gallery without disturbing the published schedule
 * slug the agenda journey asserts. The rename is undone and republished before the test
 * ends: the public projection is the demo an evaluator opens next, and the run must hand
 * it back the way it found it.
 */
test("serves an edit published during this run on the public page", async ({ page }) => {
  const original = "Accessible by default";
  const renamed = `${original} ${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  const rename = async (from: string, to: string) => {
    await page.goto(`/sessions?event=${EVENT_ID}`);
    await page.getByRole("button", { name: `Edit ${from}` }).click();
    await page.getByLabel("Session title").fill(to);
    await page.getByRole("button", { name: "Save session" }).click();
    // The editor is re-seeded from the API after a save, so this is the stored value.
    await expect(page.getByLabel("Session title")).toHaveValue(to);
    await page.getByRole("button", { name: "Close editor" }).click();
    // The row carries the title in its own cell and again in its "Edit <title>" action.
    await expect(
      page
        .getByRole("region", { name: "Accepted sessions" })
        .getByRole("cell", { name: to })
        .first(),
    ).toBeVisible();
  };

  // Start from whatever this session is called now rather than from the seeded title: an
  // earlier run that failed between the rename and the restore would otherwise leave every
  // later run unable to find the row it works on.
  const workspace = await page.request.get(`/api/events/${EVENT_ID}/content`);
  expect(workspace.ok(), `reading the content workspace failed: ${await workspace.text()}`).toBe(
    true,
  );
  const current =
    ((await workspace.json()) as { sessions: { title: string }[] }).sessions.find(({ title }) =>
      title.startsWith(original),
    )?.title ?? original;
  await rename(current, renamed);

  // Publishing takes an immutable snapshot, so the edit is in the draft and not yet on the
  // public page. The panel is where that difference is visible.
  await page.goto(`/publishing?event=${EVENT_ID}`);
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview.getByText(renamed)).toBeVisible();
  await page.getByRole("tab", { name: "Published snapshot" }).click();
  await expect(preview.getByText(renamed)).toHaveCount(0);
  await expect(page.getByText("Draft ahead of the published snapshot")).toBeVisible();

  // The visitor is still being served the previous snapshot.
  await page.goto(`/events/${SLUG}/sessions`);
  await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);

  await page.goto(`/publishing?event=${EVENT_ID}`);
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();

  // Same run, same browser: the edit is now what an anonymous visitor receives.
  await page.goto(`/events/${SLUG}/sessions`);
  await expect(page.getByRole("link", { name: renamed })).toBeVisible();
  await expect(page.getByRole("link", { name: original, exact: true })).toHaveCount(0);
  // And the slug the composer derived is the readable one it derives from the new title,
  // not a storage id.
  await page.getByRole("link", { name: renamed }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${SLUG}/sessions/accessible-by-default-\\d+$`));
  await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();

  // ---- hand the demo back ----
  await rename(renamed, original);
  await page.goto(`/publishing?event=${EVENT_ID}`);
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  await expect(
    page.getByText("The published snapshot is identical to the current draft"),
  ).toBeVisible();
  await page.goto(`/events/${SLUG}/sessions`);
  await expect(page.getByRole("link", { name: original, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
});
