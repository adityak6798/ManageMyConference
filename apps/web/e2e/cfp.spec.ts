// @acceptance ACC-CFP
import { chooseMenuItem, chooseOption } from "./controls";
import { expect, test } from "./fixtures";

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
  const current = await page.request.get(`/api/events/${EVENT_ID}/cfp`);
  expect(current.ok(), `loading the CFP revision failed: ${await current.text()}`).toBe(true);
  const currentVersion = (await current.json()).cfp.version as number;
  const seedForm = await page.request.put(`/api/events/${EVENT_ID}/cfp`, {
    data: { ...SEEDED_FORM, expectedVersion: currentVersion },
  });
  expect(seedForm.ok(), `seeding the CFP failed: ${await seedForm.text()}`).toBe(true);
  expect(
    (
      await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "publish" } })
    ).ok(),
  ).toBe(true);
  await page.goto(CFP);

  // The seeded CFP is published and matches its live snapshot, so the composer offers
  // no publish action until something actually changes.
  await expect(page.getByRole("heading", { level: 1, name: "Forms" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByText("Published · open")).toBeVisible();
  // One statement of how the draft stands to what applicants are being served, in words. It
  // replaced a pair of pills, a standing notice and a second notice restating both.
  await expect(page.getByText("Applicants are being served this exact version.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Publish/ })).toHaveCount(0);

  // The public submission URL is offered as a copyable link, not left to be guessed. It is a
  // once-a-season action, so it sits in the status bar's overflow menu with the others.
  await chooseMenuItem(page, "More call for proposals actions", "Copy public link");
  await expect(page.getByRole("status")).toContainText("Public link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/events\/greenroom-demo-summit\/cfp$/,
  );

  // ---- compose a new question ------------------------------------------------
  await page.getByRole("button", { name: "Add question" }).click();
  await page
    .getByRole("dialog", { name: "Add a question" })
    .getByRole("button", { name: /Single select/ })
    .click();
  /*
   * One question is edited at a time, in the inspector beside the list.
   *
   * Every question used to render its full editor inline and permanently open — a ten-question
   * form was roughly 4,000px of controls — so the type is chosen when the question is created
   * and the rest is edited where the list says which question is selected.
   */
  const editor = page.getByRole("complementary", { name: "Selected question" });
  await expect(editor.getByLabel("Field type")).toHaveValue("select");
  await editor.getByLabel("Question label").fill("Experience level");
  await editor.getByLabel("Guidance").fill("Choose the closest match");
  await editor.getByLabel("Option 1").fill("New");
  await editor.getByRole("button", { name: "Add option" }).click();
  await editor.getByLabel("Option 2").fill("Experienced");
  await editor.getByLabel("Required", { exact: true }).check();
  // Appended last, then moved one place up: fourth of the five questions on the form. Reordering
  // is the grip, or Ctrl/Cmd+Arrow on the question itself — a keyboard path that does not need a
  // pair of Move buttons on every row.
  await page
    .getByRole("button", { name: "Experience level", exact: true })
    .press("ControlOrMeta+ArrowUp");
  await expect(page.locator(".cfp-q-name").nth(3)).toHaveText("Experience level");

  /*
   * Editing a live form has to say so before the organizer discovers it from a confused
   * applicant. The draft preview updates immediately; the live one does not.
   *
   * The preview is what the organizer *checks*, not what they work in, so it opens on demand
   * rather than holding a permanent 460px column beside the editor.
   */
  await expect(page.getByText("Unsaved edits")).toBeVisible();
  await expect(page.getByText(/You are editing a form that is live/)).toBeVisible();
  const preview = page.getByRole("dialog", { name: "Public form" });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(preview.locator(".cfp-preview").getByText("Experience level")).toBeVisible();
  await preview.getByRole("tab", { name: "Live form" }).click();
  await expect(preview.locator(".cfp-preview").getByText("Experience level")).toHaveCount(0);
  await preview.getByRole("button", { name: "Close Public form" }).click();

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
  await page.getByRole("button", { name: "Preview" }).click();
  await preview.getByRole("tab", { name: "Live form" }).click();
  await expect(preview.locator(".cfp-preview").getByText("Experience level")).toHaveCount(0);
  await preview.getByRole("button", { name: "Close Public form" }).click();

  // ---- publishing closes the gap ---------------------------------------------
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status")).toContainText("Applicants now see this version");
  await expect(page.getByText("Applicants are being served this exact version.")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await preview.getByRole("tab", { name: "Live form" }).click();
  await expect(preview.locator(".cfp-preview").getByText("Experience level")).toBeVisible();
  await preview.getByRole("button", { name: "Close Public form" }).click();

  // ---- open/closed transitions keep unrelated editor state ---------------------
  // The composer opens on Questions, which is where the work is; the title, description and
  // window live under Form details.
  await page.getByRole("button", { name: "Form details" }).click();
  await page.getByLabel("Description").fill("A replacement draft description");
  await chooseMenuItem(page, "More call for proposals actions", "Close live CFP");
  await expect(page.getByText("Published · closed")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("A replacement draft description");
  await chooseMenuItem(page, "More call for proposals actions", "Reopen live CFP");
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
  await chooseOption(page, page.getByLabel("Experience level"), "Experienced");
  await page.getByRole("button", { name: "Submit proposal" }).click();
  // This browser is signed in, so the proposal is owned and the page keeps it on a dashboard:
  // the confirmation is announced rather than parked in the anonymous reference panel. Filtered,
  // because the page mounts its live region before it has anything to say.
  await expect(
    page.getByRole("status").filter({ hasText: /Confirmation: [0-9a-f-]{36}/ }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
});

test("a call for proposals that cannot be read blocks editing instead of offering a blank form", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click establishes the demo session asynchronously. Wait for the authenticated shell
  // before navigating, or the next document can win the race and bounce back to sign-in.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

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

  // A read that did not come back is a notice with the one control that can change that, not a
  // page heading: the surface is still the composer, and it is refusing to open a blank form.
  const refusal = page.getByRole("alert");
  await expect(refusal).toContainText("The call for proposals could not be loaded");
  await expect(refusal).toContainText("could not read");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.unroute(`**/api/events/${EVENT_ID}/cfp`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
});

test("a stale organizer draft is refused and can safely reload the winning edit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(CFP);
  // The composer opens on Questions — where the work is — so the title lives one press away
  // under Form details rather than at the top of a single scrolling form.
  await page.getByRole("button", { name: "Form details" }).click();
  await expect(page.getByLabel("Form title")).toBeVisible();

  const loaded = await page.request.get(`/api/events/${EVENT_ID}/cfp`);
  const snapshot = (await loaded.json()).cfp as typeof SEEDED_FORM & { version: number };
  await page.getByLabel("Form title").fill("Stale local title");
  const winning = await page.request.put(`/api/events/${EVENT_ID}/cfp`, {
    data: { ...SEEDED_FORM, title: "Concurrent winning title", expectedVersion: snapshot.version },
  });
  expect(winning.ok(), `winning save failed: ${await winning.text()}`).toBe(true);

  await page.getByRole("button", { name: "Save draft" }).click();
  // The service's own wording now reaches the caller rather than a fixed transport sentence, so
  // this names the editor rather than "elsewhere" — the applicant routes share this mapping and
  // were being told to reload a draft about proposals that are not drafts.
  await expect(page.getByRole("alert")).toContainText("changed in another editor");
  await expect(page.getByLabel("Form title")).toHaveValue("Stale local title");
  await page.getByRole("button", { name: "Reload latest draft" }).click();
  await expect(page.getByLabel("Form title")).toHaveValue("Concurrent winning title");
});
