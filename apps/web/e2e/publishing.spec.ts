// @acceptance ACC-PUBLIC
/*
 * Publishing, from the organizer's side, against the real API.
 *
 * `apps/web/test/publishing.test.tsx` carries the same acceptance marker but stubs every
 * fetch, so it proves the panel's rendering and nothing about the pipeline behind it. This
 * is the other half: a brand-new event, composed and published through the product's own
 * controls, read back on the public routes, and taken down again.
 *
 * It works on an event it creates rather than on the seeded demo event on purpose.
 * Unpublishing the demo event mid-suite would take the public site down under every later
 * spec — and the criterion worth proving is precisely that an event an organizer created
 * in the product, with no seeded projection behind it, can be given a public page at all.
 */
import { expect, test } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("creates an event, previews without publishing, publishes, and takes it down", async ({
  page,
}) => {
  const name = `Greenroom Publishing Trial ${Date.now()}`;
  // The public site is a client-rendered surface, so a render that throws shows as an
  // empty page rather than a failed assertion. Any uncaught error fails this test.
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.getByRole("link", { name: /Event settings/ }).click();
  await page.getByLabel("Event name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(name);

  /*
   * Give the event a day before publishing it.
   *
   * The composer takes the event's dates from the published agenda's timeslots, so an
   * event with none is published with `startsOn`/`endsOn` empty — and the public app then
   * asks `Intl` to format `""`, which throws and renders a blank page. That is issue-worthy
   * on its own; what this journey is about is the ordinary case, so it opens the board and
   * adds the slot an organizer would add before announcing anything.
   */
  await page.getByRole("link", { name: /Agenda/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  // Every workspace link carries the selected event, which is how this run learns the id
  // the console assigned. Navigating to a bare `/publishing` later would land on whichever
  // event sorts first — and unpublish that one instead.
  const eventId = new URL(page.url()).searchParams.get("event");
  expect(eventId, "the workspace URL must carry the selected event").toBeTruthy();
  // Missing agendas are read-only until the organizer explicitly creates one.
  await page.getByRole("button", { name: "Create agenda" }).click();
  // The created board names the editor in its own copy, so address the disclosure.
  await page.locator("summary").filter({ hasText: "Manage rooms, tracks, and times" }).click();
  await page.getByLabel("New timeslot start").fill("2026-11-04T09:00");
  await page.getByLabel("New timeslot end").fill("2026-11-04T10:00");
  await page.getByRole("button", { name: "Add timeslot" }).click();
  await expect(page.getByRole("status")).toContainText("Timeslot added.");
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Published version 1");

  await page.getByRole("link", { name: /Publishing/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Publishing" })).toBeVisible();

  /*
   * Each card announces into its own live region, because a confirmation that renders a
   * page away from the button that produced it is one nobody sees. So every assertion
   * below names the region it expects to hear from rather than "the page's status".
   */
  const publicationStatus = page.getByRole("region", { name: "Publication" }).getByRole("status");
  const scheduleEmbed = page.getByRole("region", { name: "Schedule", exact: true });

  // ---- nothing published yet -----------------------------------------------
  await expect(page.getByText("Not published")).toBeVisible();
  await expect(page.getByText("Draft only")).toBeVisible();
  // The address is reserved and stated before it works, so the organizer knows what it
  // will be. It is also the only place this run can learn the server-assigned slug.
  const reserved = page.locator(".publishing-url code").first();
  const slug = new URL(await reserved.innerText()).pathname.slice("/events/".length);
  expect(slug, "the panel must state a routable public slug").toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  await expect(page.getByText("answers with the standard not-published response")).toBeVisible();
  const beforePublish = await page.request.get(`/api/public/events/${slug}`);
  expect(beforePublish.status()).toBe(404);
  expect((await beforePublish.json()).error.message).toBe("This event is not published.");

  // ---- preview composes without publishing ---------------------------------
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(publicationStatus).toContainText(
    "Preview recomposed from the current draft. Nothing has been published.",
  );
  const previewPanel = page.getByRole("region", { name: "Preview" });
  await expect(previewPanel.getByText(`/events/${slug}`, { exact: true })).toBeVisible();
  // A new event has nothing accepted yet, and the composer says so rather than pretending.
  await expect(previewPanel.getByText("0 sessions")).toBeVisible();
  await expect(previewPanel.getByText("0 speakers")).toBeVisible();
  // Preview is a GET: the snapshot tab is still empty, and the route still answers 404.
  await page.getByRole("tab", { name: "Published snapshot" }).click();
  await expect(previewPanel.getByText("No snapshot has been taken")).toBeVisible();
  expect((await page.request.get(`/api/public/events/${slug}`)).status()).toBe(404);

  /*
   * ---- the public details an organizer types --------------------------------
   *
   * The criterion from issue #37: set the summary, venue and dates the public page renders
   * without curl and without SQL. Before this form existed there was no writer for `summary`
   * or `venue` anywhere in the product, so a self-created event could only ever publish an
   * empty summary and a nameless venue.
   */
  const details = page.getByRole("region", { name: "Public details" });
  await details.getByLabel("Summary").fill("Two days of practical conference craft.");
  await details.getByLabel("Venue").fill("Harbor Conference Center, Oakland");
  await details.getByLabel("First day").fill("2026-09-14");
  await details.getByLabel("Last day").fill("2026-09-15");
  await details.getByRole("button", { name: "Save public details" }).click();
  await expect(details.getByRole("status")).toContainText("Public details saved");
  // A draft write: the event is still unpublished, so nothing public has changed yet.
  expect((await page.request.get(`/api/public/events/${slug}`)).status()).toBe(404);

  // ---- publish -------------------------------------------------------------
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publicationStatus).toContainText(
    "Published. Visitors see this snapshot; later draft edits stay invisible until you publish again.",
  );
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(page.getByText("Snapshot matches the draft")).toBeVisible();
  // The public URL becomes a link the organizer can follow, not a code span.
  const publicLink = page.locator(".publishing-url a").first();
  await expect(publicLink).toHaveAttribute("href", `/events/${slug}`);
  await expect(publicLink).toHaveText(new RegExp(`/events/${slug}$`));
  // The published snapshot tab now has something in it.
  await expect(previewPanel.getByText("No snapshot has been taken")).toHaveCount(0);

  // ---- the embed snippets address the routes that now exist ----------------
  /*
   * Located on either accessible name it can carry. Confirming the copy is what *changes*
   * that name — the button becomes "Copied the Schedule embed snippet" for two seconds — so
   * a locator pinned to the resting name cannot see the state this asserts.
   */
  const copySnippet = scheduleEmbed.getByRole("button", {
    name: /^(Copy snippet for the Schedule embed|Copied the Schedule embed snippet)$/,
  });
  await copySnippet.click();
  // The click changes the button under the pointer, and the confirmation lands inside the
  // embed card the button belongs to. Both used to be invisible: the only feedback was a
  // message ~970px higher, in the Publication card, above the top of the window.
  await expect(copySnippet).toHaveText("Copied");
  await expect(scheduleEmbed.getByRole("status")).toContainText("Schedule embed snippet copied");
  await expect(publicationStatus).not.toContainText("copied to the clipboard");
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(snippet).toContain(`/embed/events/${slug}/schedule`);
  expect(snippet).toMatch(/^<iframe src="http/);
  // Every widget renders a live frame of the real embed once the event is live.
  await expect(page.locator(".publishing-frame iframe")).toHaveCount(5);

  // ---- the public routes serve it ------------------------------------------
  const published = await page.request.get(`/api/public/events/${slug}`);
  expect(published.status()).toBe(200);
  const publishedEvent = (await published.json()).projection.event;
  expect(publishedEvent.name).toBe(name);
  // The typed details reached the snapshot the public is served, which is the end of the
  // path issue #37 said did not exist.
  expect(publishedEvent).toMatchObject({
    summary: "Two days of practical conference craft.",
    venue: "Harbor Conference Center, Oakland",
    startsOn: "2026-09-14",
    endsOn: "2026-09-15",
  });

  await page.goto(`/events/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page).toHaveTitle(name);
  await expect(page.getByText("Two days of practical conference craft.")).toBeVisible();
  await expect(page.getByText("Harbor Conference Center, Oakland").first()).toBeVisible();
  await page.goto(`/embed/events/${slug}/schedule`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);

  // ---- and unpublishing takes them away ------------------------------------
  await page.goto(`/publishing?event=${eventId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Publishing" })).toBeVisible();
  await expect(page.locator(".publishing-url a").first()).toHaveAttribute(
    "href",
    `/events/${slug}`,
  );
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(publicationStatus).toContainText(
    "Unpublished. The public page, feed, and embeds now return the not-published response.",
  );
  await expect(page.getByText("Taken down")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeDisabled();

  const afterUnpublish = await page.request.get(`/api/public/events/${slug}`);
  expect(afterUnpublish.status()).toBe(404);
  expect((await afterUnpublish.json()).error.message).toBe("This event is not published.");
  for (const path of [`/events/${slug}`, `/embed/events/${slug}/schedule`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
  }

  expect(crashes, "the public site must never render through an uncaught error").toEqual([]);
});
