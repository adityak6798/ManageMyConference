// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

/*
 * The attendee-facing half of the public surface: the five surfaces an anonymous visitor
 * can reach, and the itinerary they build across them.
 *
 * Everything here runs in a fresh anonymous context with no session cookie, because that
 * is the claim under test — `/api/public/*` reads no session, and an itinerary is held by
 * an unguessable token rather than by an account. A test that signed in first could not
 * tell the two apart.
 */
test.use({
  timezoneId: "Asia/Tokyo",
  extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.7" },
  storageState: { cookies: [], origins: [] },
});

const SLUG = "greenroom-demo-summit";

/*
 * Wait until the itinerary has actually been minted and stored.
 *
 * The star flips optimistically — that is the point of it — so its label changing proves
 * only that the click was seen, not that a token exists. A navigation before the mint lands
 * therefore finds an empty `localStorage` and a page with nothing on it, which is a race
 * this suite hit under load and not in isolation.
 */
const awaitStoredItinerary = async (page: import("@playwright/test").Page) => {
  await expect
    .poll(() =>
      page.evaluate((slug) => window.localStorage.getItem(`greenroom:itinerary:${slug}`), SLUG),
    )
    .not.toBeNull();
};

const SURFACES = [
  { path: "", heading: "Greenroom Demo Summit" },
  { path: "/schedule", heading: "Plan your time" },
  { path: "/sessions", heading: "Sessions" },
  { path: "/speakers", heading: "Speakers" },
  { path: "/gallery", heading: "Speaker gallery" },
  { path: "/itinerary", heading: "My itinerary" },
];

test("reaches every public surface anonymously, on a phone, with one h1 each", async ({ page }) => {
  // 390px: the narrowest mainstream phone. The promise is not merely that the page renders
  // but that the body never scrolls sideways, which jsdom cannot measure at all.
  await page.setViewportSize({ width: 390, height: 844 });

  for (const surface of SURFACES) {
    await page.goto(`/events/${SLUG}${surface.path}`);
    await expect(page.getByRole("heading", { level: 1, name: surface.heading })).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Event navigation" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(
      overflow,
      `${surface.path || "/"} must not scroll sideways at 390px`,
    ).toBeLessThanOrEqual(0);
    // No control may be unlabelled: every one of these surfaces carries form controls.
    const unlabelled = await page.evaluate(
      () =>
        [...document.querySelectorAll("button, input, select, textarea")].filter(
          (node) =>
            !node.getAttribute("aria-label") &&
            !node.getAttribute("aria-labelledby") &&
            !(node.id && document.querySelector(`label[for="${node.id}"]`)) &&
            !node.closest("label") &&
            !node.textContent?.trim(),
        ).length,
    );
    expect(unlabelled, `${surface.path || "/"} has unlabelled controls`).toBe(0);
  }
});

test("sorts both speaker surfaces by surname and opens the same detail from each", async ({
  page,
}) => {
  const namesOn = async (path: string) => {
    await page.goto(`/events/${SLUG}${path}`);
    await expect(page.locator(".pub-speaker h3").first()).toBeVisible();
    return page.locator(".pub-speaker h3").allInnerTexts();
  };

  // Seeded speakers are Jordan Bell and Sam Speaker, so surname order is Bell then Speaker.
  expect(await namesOn("/speakers")).toEqual(["Jordan Bell", "Sam Speaker"]);
  expect(await namesOn("/gallery")).toEqual(["Jordan Bell", "Sam Speaker"]);

  await page.getByRole("link", { name: "Jordan Bell" }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${SLUG}/speakers/jordan-bell$`));
  await expect(page.getByRole("heading", { level: 1, name: "Jordan Bell" })).toBeVisible();
  // The detail carries the biography and the sessions they are down to give.
  await expect(page.getByText(/inclusive digital and physical experiences/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sessions" })).toBeVisible();
});

test("keeps a two-session itinerary across a reload and downloads it as a calendar", async ({
  page,
}) => {
  await page.goto(`/events/${SLUG}/sessions`);
  const first = "Accessible by default";
  const second = "Designing the calm conference";

  await page.getByRole("button", { name: `Add ${first} to my itinerary` }).click();
  await page.getByRole("button", { name: `Add ${second} to my itinerary` }).click();
  // Wait for the server to have accepted both, so the reload below is a real round trip
  // rather than a race against the second save.
  await expect(
    page.getByRole("button", { name: `Remove ${second} from my itinerary` }),
  ).toBeVisible();
  await awaitStoredItinerary(page);

  await page.goto(`/events/${SLUG}/itinerary`);
  await expect(page.getByRole("status")).toHaveText("2 sessions in your itinerary");

  // A reload is the whole claim: nothing survives it but the token in localStorage and the
  // row it addresses.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "My itinerary" })).toBeVisible();
  const titles = await page.locator(".pub-session h3").allInnerTexts();
  expect(titles.sort()).toEqual([first, second].sort());

  const download = await Promise.race([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download calendar (.ics)" })
      .click()
      .then(() => null),
  ]).then((event) => event ?? page.waitForEvent("download"));
  expect(download.suggestedFilename()).toBe(`${SLUG}-itinerary.ics`);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const calendar = Buffer.concat(chunks).toString("utf8");

  expect(calendar).toContain("BEGIN:VCALENDAR");
  expect(calendar).toContain("END:VCALENDAR");
  expect(calendar).toContain("VERSION:2.0");
  // Only the scheduled one becomes a calendar entry; the unscheduled session has no time
  // to put on anybody's calendar.
  expect(calendar).toContain("SUMMARY:Designing the calm conference");
  expect(calendar.match(/BEGIN:VEVENT/g) ?? []).toHaveLength(1);
  for (const line of calendar.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
});

test("hands an itinerary to another browser through its link alone", async ({ page, browser }) => {
  await page.goto(`/events/${SLUG}/sessions`);
  await page.getByRole("button", { name: "Add Accessible by default to my itinerary" }).click();
  await awaitStoredItinerary(page);
  await page.goto(`/events/${SLUG}/itinerary`);
  const shareUrl = await page
    .getByRole("link", { name: /\/itinerary\?plan=/ })
    .getAttribute("href");
  expect(shareUrl).toBeTruthy();

  // A genuinely separate browser context: no shared storage, no shared cookie jar. The link
  // is the entire claim to the itinerary, which is what "no account" costs and buys.
  const second = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const other = await second.newPage();
  await other.goto(shareUrl ?? "");
  await expect(other.getByRole("heading", { level: 1, name: "My itinerary" })).toBeVisible();
  await expect(other.getByRole("link", { name: "Accessible by default" })).toBeVisible();
  await second.close();
});

test("serves a configured embed anonymously and honours the configuration", async ({ page }) => {
  // `fields=time` drops everything optional except the clock, and the track filter narrows
  // the frame to one track. Both are read from the URL the organizer pasted, so this is the
  // same path a host page takes.
  await page.goto(`/embed/events/${SLUG}/sessions?fields=time&track=Platform`);

  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
  // Chrome is stripped inside an embed, and the itinerary star is not offered there.
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /to my itinerary/ })).toHaveCount(0);

  await expect(page.getByRole("link", { name: "Designing the calm conference" })).toBeVisible();
  // Filtered out by `track=Platform`, and its description is suppressed by `fields=time`.
  await expect(page.getByRole("link", { name: "Accessible by default" })).toHaveCount(0);
  await expect(page.locator(".pub-session-abstract")).toHaveCount(0);
  await expect(page.locator(".pub-session-meta")).toHaveCount(1);
});

test("says the same thing about one session on every surface that names it", async ({ page }) => {
  const title = "Designing the calm conference";

  await page.goto(`/events/${SLUG}/sessions`);
  const onList = await page.locator(".pub-session", { hasText: title }).innerText();
  await page.goto(`/events/${SLUG}/schedule`);
  const onSchedule = await page.locator(".pub-session", { hasText: title }).innerText();

  // Both read the one published snapshot, so the room and the track cannot disagree
  // between two surfaces of the same event.
  for (const surface of [onList, onSchedule]) {
    expect(surface).toContain("Main stage");
    // The track pill is upper-cased by CSS, and `innerText` reports what is rendered.
    // Comparing case-insensitively asserts the value rather than the styling.
    expect(surface.toLowerCase()).toContain("platform");
  }

  await page.goto(`/events/${SLUG}/sessions`);
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("Main stage", { exact: false }).first()).toBeVisible();
  // And the page states the freshness boundary rather than implying it is live.
  await expect(page.getByText(/shows the programme as last published/)).toBeVisible();
});
