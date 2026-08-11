// @acceptance ACC-CFP
import { expect, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const CFP = `/cfp?event=${EVENT_ID}`;

/**
 * The seeded form, restated so the journey below starts from one exact state.
 *
 * It has to be the *whole* seeded form, field for field. This restatement used to omit the
 * seed's "Your name" question, so the first run of this spec quietly published a narrower
 * form than the seed ships — and every spec that ran afterwards, in that run or the next,
 * met a call for proposals that no longer collected a submitter name.
 */
const SEEDED_FORM = {
  title: "Share your conference story",
  description: "Submit a practical session for Greenroom Demo Summit.",
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Proposal title",
      guidance: "Keep it specific",
      required: true,
      options: [],
    },
    {
      id: "abstract",
      type: "long_text",
      label: "Abstract",
      guidance: "What will attendees learn?",
      required: true,
      options: [],
    },
    {
      id: "name",
      type: "short_text",
      label: "Your name",
      guidance: "How organizers should address you",
      required: false,
      options: [],
    },
    {
      id: "email",
      type: "email",
      label: "Contact email",
      guidance: "We will send your confirmation here",
      required: true,
      options: [],
    },
  ],
};

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({
  permissions: ["clipboard-read", "clipboard-write"],
  extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.2" },
});

test("organizer composes, sees draft diverge from the live form, publishes, and an applicant receives a durable confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; the fixture requests below are authenticated by
  // its cookie, so wait for the signed-in shell before issuing any of them.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  // Published and matching before the journey starts, so a re-run against a fixture an
  // earlier run already edited still exercises the same transitions.
  const seedForm = await page.request.put(`/api/events/${EVENT_ID}/cfp`, { data: SEEDED_FORM });
  expect(seedForm.ok(), `seeding the CFP failed: ${await seedForm.text()}`).toBe(true);
  expect(
    (
      await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "publish" } })
    ).ok(),
  ).toBe(true);
  await page.goto(CFP);

  // The seeded CFP is published and matches its live snapshot, so the composer offers
  // no publish action until something actually changes.
  await expect(page.getByRole("heading", { level: 1, name: "Call for proposals" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByText("Published · open")).toBeVisible();
  await expect(page.getByText("Live copy matches")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Publish/ })).toHaveCount(0);

  // The public submission URL is offered as a copyable link, not left to be guessed.
  await expect(page.getByText(`/events/greenroom-demo-summit/cfp`)).toBeVisible();
  await page.getByRole("button", { name: "Copy public link" }).click();
  await expect(page.getByRole("status")).toContainText("Public link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/events\/greenroom-demo-summit\/cfp$/,
  );

  // ---- compose a new question ------------------------------------------------
  await page.getByRole("button", { name: "Add question" }).click();
  const added = page.locator(".cfp-question").last();
  await added.getByLabel("Field type").selectOption("select");
  await added.getByLabel("Question label").fill("Experience level");
  await added.getByLabel("Guidance").fill("Choose the closest match");
  await added.getByLabel("Options (comma separated)").fill("New, Experienced");
  await added.getByLabel("Required").check();
  // Appended last, then moved one place up: fourth of the five questions on the form.
  await page.getByRole("button", { name: "Move Experience level up" }).click();
  await expect(page.locator(".cfp-question-name").nth(3)).toHaveText("Experience level");

  // Editing a live form has to say so before the organizer discovers it from a
  // confused applicant. The draft preview updates immediately; the live one does not.
  await expect(page.getByText("Unsaved edits")).toBeVisible();
  await expect(page.getByText(/You are editing a form that is live/)).toBeVisible();
  await expect(page.locator(".cfp-preview").getByText("Experience level")).toBeVisible();
  await page.getByRole("tab", { name: "Live form" }).click();
  await expect(page.locator(".cfp-preview").getByText("Experience level")).toHaveCount(0);
  await page.getByRole("tab", { name: "Draft preview" }).click();

  // ---- saving announces itself, beside the button that caused it --------------
  const saveDraft = page.getByRole("button", { name: "Save draft" });
  await saveDraft.click();
  const confirmation = page.getByRole("status").filter({ hasText: "Draft saved." });
  await expect(confirmation).toBeVisible();
  const buttonBox = await saveDraft.boundingBox();
  const confirmationBox = await confirmation.boundingBox();
  // The audit found this confirmation rendering 749px below its button — off screen.
  expect(confirmationBox && buttonBox && confirmationBox.y - buttonBox.y).toBeLessThan(160);

  // A saved draft is still not what the public is being served, and says so.
  await expect(page.getByText("Draft ahead of live")).toBeVisible();
  await expect(page.getByText(/saved draft is ahead of the live form/)).toBeVisible();
  await page.getByRole("tab", { name: "Live form" }).click();
  await expect(page.locator(".cfp-preview").getByText("Experience level")).toHaveCount(0);

  // ---- publishing closes the gap ---------------------------------------------
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status")).toContainText("Applicants now see this version");
  await expect(page.getByText("Live copy matches")).toBeVisible();
  await expect(page.locator(".cfp-preview").getByText("Experience level")).toBeVisible();

  // ---- open/closed transitions keep unrelated editor state ---------------------
  await page.getByLabel("Description").fill("A replacement draft description");
  await page.getByRole("button", { name: "Close live CFP" }).click();
  await expect(page.getByText("Published · closed")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("A replacement draft description");
  await page.getByRole("button", { name: "Reopen live CFP" }).click();
  await expect(page.getByText("Published · open")).toBeVisible();

  // ---- 390px: the composer stacks rather than scrolling sideways ---------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(CFP);
  await expect(page.getByText("Published · open")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- the applicant's side of the same form ----------------------------------
  await page.goto("/events/greenroom-demo-summit/cfp");
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
  await page.getByLabel("Proposal title").fill("Idempotent conference workflows");
  await page.getByLabel("Abstract").fill("A practical session about reliable submissions.");
  await page.getByLabel("Contact email").fill("speaker@example.com");
  await page.getByLabel("Experience level").selectOption("Experienced");
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("status")).toContainText(/Confirmation: [0-9a-f-]{36}/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
});

test("a call for proposals that cannot be read blocks editing instead of offering a blank form", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  // A malformed payload used to collapse into "Something went wrong" and leave the
  // starter template in the editor, one Save away from overwriting the real form.
  await page.route(`**/api/events/${EVENT_ID}/cfp`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cfp: { eventId: EVENT_ID, title: "Broken" } }),
    }),
  );
  await page.goto(CFP);

  await expect(
    page.getByRole("heading", { name: "The call for proposals could not be opened" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("could not read");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.unroute(`**/api/events/${EVENT_ID}/cfp`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
});
