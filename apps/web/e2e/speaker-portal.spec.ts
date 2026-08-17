// @acceptance ACC-SPEAKER
import { text } from "node:stream/consumers";
import { switchPersona } from "./controls";
import { expect, type Page, test } from "./fixtures";

// Both surfaces are event-scoped, so the journey addresses them the way the console
// links to them: /sessions?event=<uuid> for organizers, /portal?event=<uuid> for speakers.
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SESSIONS = `/people?event=${EVENT_ID}&tab=speakers`;
const TRIAGE = `/abstracts?event=${EVENT_ID}`;
const PORTAL = `/portal?event=${EVENT_ID}`;

// The abstract this journey promotes into the programme. It is a real seeded submission
// carrying a real contact address, which is what makes it acceptable at all.
const HALLWAY = "Designing for the hallway track";
// The seeded speaker whose portal this journey works in.
const SAM = "10000000-0000-4000-8000-000000000001";
const SLUG = "greenroom-demo-summit";
/** The onboarding checklist the seed gives Sam, and the state this journey hands back. */
const SEEDED_TASKS = ["Confirm profile details", "Upload a headshot"];

/*
 * A real 1x1 PNG, so the assertions below can demand that the browser actually decoded the
 * bytes the asset route served. Three arbitrary bytes labelled `image/png` upload and store
 * fine and render as a broken tile, which is exactly the failure this journey exists to catch.
 */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const decoded = (image: HTMLImageElement | SVGElement) => (image as HTMLImageElement).naturalWidth;

interface Workspace {
  tasks: { id: string; speakerProfileId: string; title: string; status: string }[];
  speakers: { id: string; version: number; photoAssetId?: string }[];
  assets: {
    id: string;
    name: string;
    visibility: string;
    // Optional the way the contract declares them: a row written before versioning existed
    // carries none, and the journeys below assert what the current writer stores.
    versionNumber?: number;
    isLatest?: boolean;
    versionGroupId?: string;
  }[];
}

/**
 * Put Sam's onboarding checklist back to the two open tasks the seed ships.
 *
 * Completing a task is one-way — there is no "reopen" in the product — so the portal's
 * counts would read differently on every run against a shared fixture. This closes
 * whatever is open and re-requests the seeded pair through the organizer's own route, so
 * the journey below starts from one exact state and a judge who opens the demo after a
 * run still finds a speaker with work to do.
 */
async function restoreOnboardingChecklist(page: Page) {
  // Each half of this is done by the identity the product allows to do it: only the
  // speaker may complete their own task, and only an organizer may request one.
  const become = async (persona: "organizer" | "speaker") =>
    expect((await page.request.post("/api/demo-session", { data: { persona } })).ok()).toBe(true);

  await become("organizer");
  const workspace = await page.request.get(`/api/events/${EVENT_ID}/content`);
  expect(workspace.ok(), `reading the content workspace failed: ${await workspace.text()}`).toBe(
    true,
  );
  const workspaceBody = (await workspace.json()) as Workspace;
  const open = workspaceBody.tasks.filter(
    (task) => task.speakerProfileId === SAM && task.status === "open",
  );

  if (open.length) {
    await become("speaker");
    for (const task of open)
      expect(
        (await page.request.post(`/api/events/${EVENT_ID}/tasks/${task.id}/complete`)).ok(),
        `completing ${task.title} failed`,
      ).toBe(true);
    await become("organizer");
  }

  for (const title of SEEDED_TASKS)
    expect(
      (
        await page.request.post("/api/speaker-tasks", {
          data: { profileId: SAM, title, dueAt: "2026-08-20T23:59:00.000Z" },
        })
      ).ok(),
      `requesting ${title} failed`,
    ).toBe(true);

  // The seed gives Sam no headshot — that is what makes "Upload a headshot" real work — so a
  // run that ended between choosing one and handing it back is put right here rather than
  // leaving every later run starting from a state the seed never describes. This is also the
  // organizer half of the photo route: an organizer may remove a speaker's headshot.
  const profile = workspaceBody.speakers.find(({ id }) => id === SAM);
  if (profile?.photoAssetId) {
    const clearedPhoto = await page.request.delete(`/api/speaker-profiles/${SAM}/photo`, {
      data: { expectedVersion: profile.version },
    });
    expect(
      clearedPhoto.ok(),
      `clearing the seeded photo failed: ${await clearedPhoto.text()}`,
    ).toBe(true);
  }
}

/**
 * Open every collapsed tool panel.
 *
 * They are `<details>`, closed by default, and a closed disclosure keeps its contents out of
 * the accessibility tree — so a journey that asserts on a control inside one has to open it
 * first. Set rather than clicked: which panel holds which control is not what these journeys
 * are about, and clicking each summary by name would break every time one is renamed.
 */
async function openToolPanels(page: Page) {
  // The heading renders before the workspace fetch resolves, so waiting on it is not enough:
  // the panels have to exist before anything can open them.
  await expect(page.locator("details.tool-panel").first()).toBeVisible();
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLDetailsElement>("details.tool-panel"))
      node.open = true;
  });
  await expect(page.locator("details.tool-panel[open]").first()).toBeVisible();
}

/** The organizer's view of the demo event's content, which is where ids come from. */
async function contentWorkspace(page: Page): Promise<Workspace> {
  const response = await page.request.get(`/api/events/${EVENT_ID}/content`);
  expect(response.ok(), `reading the content workspace failed: ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as Workspace;
}

/** Publish the demo event, which is what moves a draft change onto the public page. */
async function publishEvent(page: Page) {
  await page.goto(`/publishing?event=${EVENT_ID}`);
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
}

test("organizer tracks accepted content and speaker completes portal work", async ({
  page,
  browser,
}) => {
  // Everything this run creates is stamped, so a second run against the same fixture
  // addresses its own rows rather than colliding with the previous run's.
  const run = Date.now();
  const requestedTask = `Upload final presentation ${run}`;
  const messageSubject = `Speaker preparation reminder ${run}`;
  const headshot = `headshot-${run}.png`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await restoreOnboardingChecklist(page);
  await page.goto(SESSIONS);

  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  const sessions = page.getByRole("region", { name: "Accepted sessions" });
  // Each row also carries an "Edit <title>" action cell, so match the title cell exactly.
  await expect(
    sessions.getByRole("cell", { name: "Designing the calm conference", exact: false }).first(),
  ).toBeVisible();

  // Sessions are never created from this workspace: content appears here only because an
  // abstract was accepted in review, which provisions its speaker in the same request.
  await page.goto(TRIAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  /*
   * A queue row offers one way in to a decision rather than four outcome buttons — around 240
   * of them on a sixty-row queue is what forced the table sideways — and the outcomes live in
   * the drawer, beside the text the organizer is deciding on.
   *
   * A row whose decision is already recorded no longer offers that same outcome again — the
   * control that did nothing was removed — so on a second run against a fixture this spec has
   * already accepted, the abstract is simply confirmed to be accepted and the acceptance step
   * is skipped. That is what keeps this journey re-runnable (issue #72).
   *
   * `count()` does not auto-wait, so the row itself is awaited first: counting straight after
   * the heading appears reads an empty table, silently skips the acceptance, and then fails on
   * an assertion about a board nothing ever decided. Scoped to the triage table: the "Recent
   * changes" audit below it lists the same title on every transition.
   */
  const hallwayRow = page.locator(".triage-table").getByRole("row", { name: new RegExp(HALLWAY) });
  await expect(hallwayRow).toBeVisible();
  await hallwayRow
    .getByRole("button", { name: new RegExp(`^(Decide|Change) ${HALLWAY}$`) })
    .click();
  const abstract = page.getByRole("dialog", { name: HALLWAY });
  const acceptHallway = abstract.getByRole("button", { name: `Accept ${HALLWAY}`, exact: true });
  if (await acceptHallway.count()) {
    await acceptHallway.click();
    const decision = page.getByRole("region", { name: "Accept this abstract" });
    await expect(decision).toContainText("links Alex Morgan (alex.morgan@example.test)");
    // The question is asked over the table, not appended below it. `:modal` is the browser's
    // own answer to "is this in the top layer with a backdrop and a focus trap", which is the
    // one thing jsdom cannot tell us — the earlier non-modal block rendered several hundred
    // pixels below the control that opened it and read as a dead button.
    await expect(page.locator("dialog.decision-dialog")).toBeVisible();
    expect(
      await page.locator("dialog.decision-dialog").evaluate((node) => node.matches(":modal")),
    ).toBe(true);
    await decision.getByRole("button", { name: "Confirm acceptance" }).click();
    await expect(decision.getByRole("status")).toContainText(
      // The destination is named the way the sidebar names it, so the sentence is a route.
      `“${HALLWAY}” is accepted. It is now a session under Schedule → Sessions with Alex Morgan linked as its speaker.`,
    );
    // The dialog is modal, so while it is open every other element is out of the accessibility
    // tree and no role query can reach the table behind it. Dismiss it before reading the row.
    await decision.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("dialog.decision-dialog")).toBeHidden();
  }
  // Either way the abstract now records the outcome, and only the reversal is still on offer.
  await expect(abstract.getByText("Accepted", { exact: true }).first()).toBeVisible();
  await expect(abstract.getByRole("button", { name: /^Decline instead/ })).toBeVisible();
  await expect(abstract.getByRole("button", { name: `Accept ${HALLWAY}` })).toHaveCount(0);
  await abstract.getByRole("button", { name: `Close ${HALLWAY}` }).click();
  await expect(abstract).toBeHidden();
  // And the row says so too, from the decision column that offers the way back in.
  await expect(hallwayRow.getByText("Accepted", { exact: true }).first()).toBeVisible();

  await page.goto(SESSIONS);
  await expect(sessions.getByRole("cell", { name: HALLWAY, exact: false }).first()).toBeVisible();
  await expect(
    sessions.getByRole("row", { name: new RegExp(HALLWAY) }).getByText("Alex Morgan"),
  ).toBeVisible();

  // The editor is an inline disclosure on the row, so only the expanded session's
  // fields are in the accessibility tree at any one time.
  await page.getByRole("button", { name: `Edit ${HALLWAY}` }).click();
  await expect(page.getByLabel("Session title")).toHaveValue(HALLWAY);
  await page.getByLabel("Session title").fill("Organizer-managed session");
  await page.getByLabel("Publication readiness").selectOption("ready");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions.getByRole("cell", { name: "Organizer-managed session" })).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveValue("Organizer-managed session");
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("tab", { name: "Ready 1" })).toBeVisible();

  // Hand the session back the way acceptance created it. The edit above is the assertion;
  // leaving it applied would make the next run open an editor whose title no longer names
  // the abstract it came from, and would leave the demo carrying a placeholder title.
  await page.getByRole("button", { name: "Edit Organizer-managed session" }).click();
  await page.getByLabel("Session title").fill(HALLWAY);
  await page.getByLabel("Publication readiness").selectOption("draft");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions.getByRole("cell", { name: HALLWAY, exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("tab", { name: "Ready 0" })).toBeVisible();

  // Tasks and messages are addressed to the speaker the organizer picks, not to
  // whichever profile happens to be first in the workspace payload.
  const followUp = page.getByRole("region", { name: "Speaker follow-up" });
  await followUp.getByLabel("Speaker").selectOption({ label: "Sam Speaker — Greenroom Labs" });
  await followUp.getByLabel("Request a task").fill(requestedTask);
  await followUp.getByLabel("Due date").fill("2026-09-01");
  await followUp.getByRole("button", { name: "Request this task" }).click();
  await expect(followUp.getByRole("status")).toContainText(
    `Requested “${requestedTask}” from Sam Speaker.`,
  );

  await followUp.getByLabel("Record a communication").fill(messageSubject);
  await followUp.getByRole("button", { name: "Record this message" }).click();
  // The announcement quotes the subject the organizer typed, so it names the record it made.
  await expect(followUp.getByRole("status")).toContainText(
    `Logged “${messageSubject}” to Sam Speaker.`,
  );
  await expect(
    page.getByRole("region", { name: "Communication history" }).getByText(messageSubject),
  ).toBeVisible();

  // ---- speaker portal ----
  await switchPersona(page, "Speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);
  await expect(page.getByRole("heading", { name: "Speaker resources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speaker handbook" })).toBeVisible();

  // The two seeded onboarding tasks plus the one the organizer just requested; the count
  // reads as a sentence, so the singular form has to be correct on the last one.
  await expect(
    page.getByRole("button", { name: new RegExp(`^Mark complete .*${requestedTask}$`) }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "3 tasks to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "2 tasks to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "1 task to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "You’re all caught up" })).toBeVisible();

  const profile = page.getByRole("region", { name: "Your public profile" });
  await profile.getByLabel("Bio").fill("Speaker-managed public biography.");
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect(profile.getByRole("status")).toContainText("Profile saved.");
  // The form is controlled and re-seeded from the API, so a reload shows the stored value.
  await page.reload();
  await expect(page.getByLabel("Bio")).toHaveValue("Speaker-managed public biography.");

  const uploads = page.getByRole("region", { name: "Private uploads" });
  await uploads.getByLabel("Speaker asset").setInputFiles({
    name: headshot,
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1X1, "base64"),
  });
  await uploads.getByRole("button", { name: "Upload asset" }).click();
  await expect(uploads.getByRole("status")).toContainText(`${headshot} uploaded privately.`);
  await expect(uploads.getByText("Private", { exact: true }).first()).toBeVisible();

  // ---- the headshot: chosen by the speaker, published by the organizer ----
  //
  // `speaker_profiles.photo_asset_id` was read by the public projection and cleared when its
  // file was deleted, and nothing in the product could write it, so this is the step that used
  // to be missing entirely. Choosing it is the speaker's own action, and it is deliberately
  // *not* publication: the portal has to say so, because the speaker cannot make that call.
  await expect(uploads.getByText(/You have no profile photo/)).toBeVisible();
  const uploadedFile = uploads.locator("li").filter({ hasText: headshot });
  await uploadedFile.getByRole("button", { name: /^Use as profile photo/ }).click();
  await expect(uploads.getByRole("status")).toContainText(
    `“${headshot}” is now your profile photo. It is not public yet`,
  );
  // The picture itself, fetched from the asset route by its owner's own session. A tile that
  // renders as a broken image would still satisfy an assertion on the `src` attribute alone.
  const preview = uploads.locator("img.photo-preview");
  await expect(preview).toHaveAttribute("src", /\/api\/speaker-assets\//);
  await expect.poll(() => preview.evaluate(decoded)).toBeGreaterThan(0);

  // A slide deck cannot be a face. The portal never offers the control for one, so the
  // refusal is asserted where a determined client would meet it: on the route.
  const slides = await page.request.post("/api/speaker-assets", {
    data: {
      profileId: SAM,
      name: `slides-${run}.pdf`,
      contentType: "application/pdf",
      contentBase64: "JVBERi0xLjQK",
    },
  });
  expect(slides.status(), `uploading a slide deck failed: ${await slides.text()}`).toBe(201);
  const slidesId = ((await slides.json()) as { asset: { id: string } }).asset.id;
  await expect(uploads.locator("li").filter({ hasText: `slides-${run}.pdf` })).toHaveCount(0);
  const refusedPdf = await page.request.put(`/api/speaker-profiles/${SAM}/photo`, {
    data: {
      assetId: slidesId,
      expectedVersion: (await contentWorkspace(page)).speakers.find(({ id }) => id === SAM)
        ?.version,
    },
  });
  expect(refusedPdf.status()).toBe(400);
  expect(
    ((await refusedPdf.json()) as { error: { fieldErrors: { assetId: string[] } } }).error
      .fieldErrors.assetId[0],
  ).toContain("not an image");
  expect((await page.request.delete(`/api/speaker-assets/${slidesId}`)).status()).toBe(204);

  // Only an organizer can clear a private upload for publication. Switching identity off
  // the speaker portal lands on the organizer's own home, since /portal is not a route an
  // organizer can reach; navigate to the sessions workspace from there.
  await switchPersona(page, "Organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  const assets = page.getByRole("region", { name: "Speaker assets" });
  // The publish control repeats the filename in its accessible name, so match the cell
  // that names the file, its content type, and the headshot the speaker just chose.
  await expect(
    assets.getByRole("cell", { name: `${headshot} image/png · Profile photo` }),
  ).toBeVisible();
  const uploaded = assets.getByRole("row", { name: new RegExp(headshot) });
  // An organizer has to be able to take delivery of what a speaker sent, not just see it listed
  // (issue #62). The bytes are read back so a link pointing at nothing would fail here.
  const assetDownload = await Promise.all([
    page.waitForEvent("download"),
    uploaded.getByRole("link", { name: /^Download/ }).click(),
  ]).then(([event]) => event);
  expect(assetDownload.suggestedFilename()).toBe(headshot);
  const delivered = await assetDownload.createReadStream().then(async (stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  });
  // A PNG, byte for byte — the organizer received the file, not an error page.
  expect([...delivered.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  await uploaded.getByRole("button", { name: /^Mark publishable/ }).click();
  // The control stays in place so keyboard focus survives the round trip, and it now offers
  // the reverse — publication is withdrawable, which the end of this journey uses. The seed
  // already ships one publishable headshot and every earlier run left another, so the
  // assertion is scoped to the row for the file this run uploaded.
  await expect(uploaded.getByRole("button", { name: /^Make private/ })).toBeVisible();

  // ---- publish, and read the face off the public gallery ----
  const assetId = (await contentWorkspace(page)).assets.find(({ name }) => name === headshot)?.id;
  expect(assetId, "the uploaded headshot must be in the organizer workspace").toBeTruthy();
  await publishEvent(page);

  // A visitor with no session at all: a separate browser context, so nothing this run signed
  // into can be what makes the image load.
  const visitorOrigin = new URL(page.url()).origin;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${visitorOrigin}/events/${SLUG}/speakers`);
  const samTile = visitor.locator(".pub-speaker").filter({ hasText: "Sam Speaker" });
  const samAvatar = samTile.locator("img.pub-avatar");
  await expect(samAvatar).toHaveAttribute("src", `/api/speaker-assets/${assetId}`);
  await samAvatar.scrollIntoViewIfNeeded();
  await expect.poll(() => samAvatar.evaluate(decoded)).toBeGreaterThan(0);

  // And the portal now tells the speaker the thing that changed: it is public.
  await switchPersona(page, "Speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);
  await expect(uploads.getByText("It is visible on the published programme.")).toBeVisible();

  // ---- withdrawal: unpublishing the file takes the face off the gallery (issue #86) ----
  await switchPersona(page, "Organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(SESSIONS);
  await uploaded.getByRole("button", { name: /^Make private/ }).click();
  await expect(uploaded.getByRole("button", { name: /^Mark publishable/ })).toBeVisible();
  await publishEvent(page);
  await visitor.goto(`${visitorOrigin}/events/${SLUG}/speakers`);
  // Back to a monogram, and the seeded portrait is the only face on the page again.
  await expect(samTile.locator("span.pub-avatar")).toHaveText("SS");
  await expect(visitor.locator(".pub-speaker img.pub-avatar")).toHaveCount(1);
  await visitorContext.close();

  // Deleting the file clears the profile that pointed at it, so no later publish can
  // advertise a URL the asset route would refuse. This also hands the fixture back.
  expect((await page.request.delete(`/api/speaker-assets/${assetId}`)).status()).toBe(204);
  const afterDelete = await contentWorkspace(page);
  expect(afterDelete.assets.some(({ id }) => id === assetId)).toBe(false);
  expect(afterDelete.speakers.find(({ id }) => id === SAM)?.photoAssetId).toBeUndefined();

  await switchPersona(page, "Speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);
  const calendar = page.getByRole("link", { name: "Download calendar (.ics)" });
  await expect(calendar).toBeVisible();
  const started = page.waitForEvent("download");
  await calendar.click();
  const download = await started;
  expect(download.suggestedFilename()).toBe("greenroom-sessions.ics");

  // Read the bytes the speaker's calendar app would actually import, not just the filename.
  const ics = await text(await download.createReadStream());
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("SUMMARY:Designing the calm conference");
  /*
   * The instant comes from the agenda placement in force — the seeded publication puts this
   * session in `slot-0900`, 2026-09-01T16:00:00Z — which is why it equals what the public
   * schedule serves. It is not a column of its own: `content_sessions` used to carry one that
   * nothing but the seed ever wrote, and this assertion pinned that fiction.
   * RFC 5545 writes the instant as a UTC DATE-TIME.
   */
  expect(ics).toContain("DTSTART:20260901T160000Z");
  expect(ics).toContain("LOCATION:Main stage");
  // RFC 5545 section 3.6.1 makes DTSTAMP mandatory in a VEVENT, and Outlook rejects it without one.
  expect(ics).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);

  // Hand the checklist back so the demo still shows a speaker with outstanding work.
  await switchPersona(page, "Organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await restoreOnboardingChecklist(page);
});

test("reviewers cannot call the private content workspace", async ({ request }) => {
  // Anonymous first: the photo routes are authenticated, so they are 401 before they are 403.
  expect(
    (
      await request.put(`/api/speaker-profiles/${SAM}/photo`, {
        data: { assetId: "90000000-0000-4000-8000-000000000001", expectedVersion: 0 },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.delete(`/api/speaker-profiles/${SAM}/photo`, {
        data: { expectedVersion: 0 },
      })
    ).status(),
  ).toBe(401);

  const session = await request.post("/api/demo-session", { data: { persona: "reviewer" } });
  expect(session.ok()).toBeTruthy();
  const response = await request.get(`/api/events/${EVENT_ID}/content`);
  expect(response.status()).toBe(403);
  // A reviewer on this event has content access to nothing, including a speaker's headshot:
  // choosing one belongs to the speaker and to the organizers, and to nobody else.
  expect(
    (
      await request.put(`/api/speaker-profiles/${SAM}/photo`, {
        data: { assetId: "90000000-0000-4000-8000-000000000001", expectedVersion: 0 },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.delete(`/api/speaker-profiles/${SAM}/photo`, {
        data: { expectedVersion: 0 },
      })
    ).status(),
  ).toBe(403);
});

/*
 * The three journeys #189 names that no browser test drove before.
 *
 * They share one fixture with everything else in this suite, so each brings its own stamped
 * data where it can and hands the roster back where it cannot — the same discipline
 * `restoreOnboardingChecklist` already applies.
 */

/**
 * CNT-04, end to end.
 *
 * The evaluator uploaded `slides.pdf` twice and got two separate v1 assets. Asserted here
 * through the portal rather than against the service, because the readable half of that defect
 * was the portal listing two rows with the same name and nothing marking either as current.
 */
test("a speaker re-uploads one deliverable and gets a second version, not a twin", async ({
  page,
}) => {
  const stamp = Date.now();
  const name = `deck-${stamp}.pdf`;
  // A tiny but real PDF, so the bytes the asset route serves back are the bytes uploaded.
  const pdf = (marker: string) =>
    Buffer.from(
      `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
    );

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as speaker" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(PORTAL);

  const upload = async (marker: string) => {
    await page.setInputFiles("#speaker-asset", {
      name,
      mimeType: "application/pdf",
      buffer: pdf(marker),
    });
    await page.getByRole("button", { name: /Upload asset/ }).click();
    await expect(page.getByRole("status").filter({ hasText: `${name} uploaded` })).toBeVisible();
  };

  await upload("first");
  await upload("second");

  // One entry, not two, and it says which version it is.
  const entry = page.locator(".upload-list > li").filter({ hasText: name });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("Version 2");
  await expect(entry.getByText("Latest", { exact: true })).toBeVisible();

  // The superseded version is still reachable, which is the other half of the requirement.
  const history = entry.locator("details.upload-history");
  await expect(history).toContainText("1 earlier version");
  // Closed by default, and a closed disclosure keeps its contents out of the accessibility
  // tree — which is the point of collapsing it, and means the journey has to open it.
  await history.locator("summary").click();
  const priorLink = history.getByRole("link", { name: /Version 1/ });
  await expect(priorLink).toHaveAttribute("href", /\/api\/speaker-assets\//);
  const priorHref = (await priorLink.getAttribute("href")) ?? "";
  const prior = await page.request.get(priorHref);
  expect(prior.ok()).toBe(true);
  // v1's bytes, not v2's: "retained" has to mean the file, not a row.
  expect(await prior.text()).toContain("% first");

  // And the storage agrees with the screen.
  const stored = (await contentWorkspace(page)).assets.filter((asset) => asset.name === name);
  expect(stored).toHaveLength(2);
  expect(new Set(stored.map(({ versionGroupId }) => versionGroupId)).size).toBe(1);
  expect(stored.filter(({ isLatest }) => isLatest !== false)).toHaveLength(1);
  expect(stored.map(({ versionNumber }) => versionNumber).sort()).toEqual([1, 2]);
});

/**
 * A speaker edits their profile; the organizer reads back exactly the same values.
 *
 * The links matter more than the text: they are new, they reach the public page, and the box
 * that carries them is the one place a speaker can put a URL that every visitor's browser is
 * later invited to follow.
 */
test("a speaker's links reach the organizer and the published programme", async ({ page }) => {
  const stamp = Date.now();
  const site = `https://sam-${stamp}.example`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as speaker" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(PORTAL);

  // A valid URL whose scheme is a script. The public page renders these into an `href`, so
  // this is the refusal the field exists to make — and it lands on the box that caused it.
  await page.getByLabel("Website", { exact: true }).fill("javascript:alert(1)");
  await page.getByRole("button", { name: /Save profile/ }).click();
  await expect(page.locator("#profile-social-website-error")).toContainText("http:// or https://");

  await page.getByLabel("Website", { exact: true }).fill(site);
  await page.getByLabel("Mastodon").fill(`https://hachyderm.io/@sam-${stamp}`);
  await page.getByRole("button", { name: /Save profile/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

  // The organizer reads the same values, on the surface that maintains the rest of the roster.
  await page.request.post("/api/demo-session", { data: { persona: "organizer" } });
  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  await openToolPanels(page);
  // The picker defaults to whoever sorts first, and this fixture accumulates speakers across
  // runs — so the journey names the speaker whose profile it just edited.
  const picker = page.locator(".workflow-picker select").nth(1);
  // The option carries the workflow status after the name, so the value is what identifies it.
  await picker.selectOption(SAM);
  const entered = page.locator(".speaker-entered");
  await expect(entered).toContainText("Greenroom Labs");
  await expect(entered.getByRole("link", { name: "Website" })).toHaveAttribute("href", site);

  // And publishing freezes them onto the public page.
  await publishEvent(page);
  const projection = await page.request.get(`/api/public/events/${SLUG}`);
  const speakers = (
    (await projection.json()) as {
      projection: {
        speakers: { name: string; slug: string; socialLinks?: Record<string, string> }[];
      };
    }
  ).projection.speakers;
  const sam = speakers.find(({ name }) => name === "Sam Speaker");
  expect(sam?.socialLinks?.website).toBe(site);

  await page.goto(`/events/${SLUG}/speakers/${sam?.slug ?? ""}`);
  const link = page.getByRole("navigation", { name: /Links for Sam Speaker/ }).getByRole("link", {
    name: /Website/,
  });
  await expect(link).toHaveAttribute("href", site);
  // A speaker-supplied destination must not be handed a reference to the programme's window.
  await expect(link).toHaveAttribute("rel", /noopener/);
});

/**
 * Filter outstanding work, chase it, and press again.
 *
 * The second press is the assertion: reminders converge on one delivery per (task, deadline),
 * so an organizer must be told the speaker has already been reminded rather than that a second
 * message was queued.
 */
test("an organizer chases outstanding work once per deadline", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await restoreOnboardingChecklist(page);

  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  await openToolPanels(page);

  // The filter is the point: this view is what an organizer opens to find what is missing.
  await expect(page.locator(".deliverable-filters").getByLabel("Show")).toHaveValue("outstanding");
  const table = page.locator(".deliverable-table");
  for (const title of SEEDED_TASKS) await expect(table).toContainText(title);

  await page.getByLabel("Select every task in this view").check();
  await page.getByRole("button", { name: /^Send \d+ reminders?$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /reminders? queued/ })).toBeVisible();

  await page.getByLabel("Select every task in this view").check();
  await page.getByRole("button", { name: /^Send \d+ reminders?$/ }).click();
  // Converged rather than sent again, and it says so in those words.
  await expect(
    page.getByRole("status").filter({ hasText: "already sent for this deadline" }),
  ).toBeVisible();

  // Delivery state, from the domain that owns it.
  // History is ordered oldest first and this fixture accumulates, so the page these reminders
  // landed on is the last one — walk the cursor rather than assuming it is the first.
  type Delivery = { delivery: { triggerType: string; idempotencyKey?: string } };
  let cursor: string | null = null;
  const entries: Delivery[] = [];
  for (let index = 0; index < 20; index += 1) {
    const url = `/api/communications/history?organizationId=00000000-0000-4000-8000-000000000010&eventId=${EVENT_ID}&limit=50${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { history: Delivery[]; nextCursor: string | null };
    entries.push(
      ...body.history.filter(({ delivery }) => delivery.triggerType === "speaker.task_reminder"),
    );
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  expect(entries.length).toBeGreaterThan(0);
  // Keyed by the deadline, which is what makes an extension a new occurrence rather than a
  // suppressed duplicate.
  expect(
    entries.every(({ delivery }) => /^task-reminder:.+:\d{4}-/.test(delivery.idempotencyKey ?? "")),
  ).toBe(true);

  // A filter that matches nothing explains itself rather than rendering an empty table.
  // Scoped to the tracker: the workflow panel below carries a "Speaker" select of its own.
  const filters = page.locator(".deliverable-filters");
  await filters.getByLabel("Show").selectOption("complete");
  await filters.getByLabel("Speaker").selectOption({ label: "Jordan Bell" });
  await expect(page.getByRole("heading", { name: "Nothing matches this view" })).toBeVisible();
});

/** The organization the demo event belongs to, which is how its delivery history is addressed. */
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
/** The second seeded speaker, invited alongside Sam below so one press covers two profiles. */
const JORDAN = "10000000-0000-4000-8000-000000000002";

/** The roster's own phrasing for a count, so an assertion reads back what the cell says. */
const invitations = (count: number) => `${count} ${count === 1 ? "invitation" : "invitations"}`;

interface RosterSpeaker {
  id: string;
  name: string;
  email: string;
  bio: string;
  pronouns: string;
  jobTitle: string;
  organization: string;
  version: number;
  photoAssetId?: string;
  socialLinks?: Record<string, string>;
  /** Optional the way the contract declares it: a profile written before `1408` carries none. */
  invitationsSent?: number;
}

interface InvitationDelivery {
  id: string;
  idempotencyKey: string;
  triggerType: string;
  recipientRef: string;
  renderedBody: string | null;
  payload: Record<string, unknown>;
}

/** One speaker as the organizer's roster reports them, including their invitation count. */
async function rosterEntry(page: Page, profileId: string): Promise<RosterSpeaker> {
  const response = await page.request.get(`/api/events/${EVENT_ID}/content`);
  expect(response.ok(), `reading the content workspace failed: ${await response.text()}`).toBe(
    true,
  );
  const { speakers } = (await response.json()) as { speakers: RosterSpeaker[] };
  const entry = speakers.find(({ id }) => id === profileId);
  if (!entry) throw new Error(`${profileId} is not on this event's roster`);
  return entry;
}

/**
 * Every delivery this event has ever filed under one speaker's invitation key.
 *
 * History is ordered oldest first and this fixture accumulates, so the page an invitation just
 * landed on is the last one — the cursor is walked rather than assuming the newest rows are on
 * the first page, the same way `crm.spec.ts` walks it.
 */
async function invitationsFor(page: Page, profileId: string): Promise<InvitationDelivery[]> {
  const prefix = `speaker-invite:${EVENT_ID}:${profileId}`;
  const found: InvitationDelivery[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 20; index += 1) {
    const response = await page.request.get(
      `/api/communications/history?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}&limit=50${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(response.ok(), `reading the delivery history failed: ${await response.text()}`).toBe(
      true,
    );
    const body = (await response.json()) as {
      history: { delivery: InvitationDelivery }[];
      nextCursor: string | null;
    };
    for (const { delivery } of body.history)
      if (delivery.idempotencyKey.startsWith(prefix)) found.push(delivery);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return found;
}

test("the organizer searches speakers without filtering sessions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(SESSIONS);

  const roster = page.getByRole("region", { name: "Speakers", exact: true });
  const sessions = page.getByRole("region", { name: "Accepted sessions", exact: true });
  const speakerSearch = roster.getByLabel("Search speaker roster");
  const sessionSearch = sessions.getByLabel("Search sessions");

  await expect(roster.getByRole("row", { name: /Sam Speaker/ })).toBeVisible();
  await expect(roster.getByRole("row", { name: /Jordan Bell/ })).toBeVisible();
  await speakerSearch.fill("Northwind Access");
  await expect(roster.getByRole("row", { name: /Jordan Bell/ })).toBeVisible();
  await expect(roster.getByRole("row", { name: /Sam Speaker/ })).toHaveCount(0);
  // The speaker query cannot silently become the session query: both accepted sessions remain.
  await expect(sessions.getByRole("row", { name: /Designing the calm conference/ })).toBeVisible();
  await expect(sessions.getByRole("row", { name: /Accessible by default/ })).toBeVisible();

  await speakerSearch.fill("");
  await sessionSearch.fill("Accessible by default");
  await expect(sessions.getByRole("row", { name: /Accessible by default/ })).toBeVisible();
  await expect(sessions.getByRole("row", { name: /Designing the calm conference/ })).toHaveCount(0);
  // And the session query cannot silently narrow the speaker roster in the other direction.
  await expect(roster.getByRole("row", { name: /Sam Speaker/ })).toBeVisible();
  await expect(roster.getByRole("row", { name: /Jordan Bell/ })).toBeVisible();
});

test("an organizer edits the canonical profile the speaker and public programme read", async ({
  page,
}) => {
  const stamp = Date.now();
  const bio = `Organizer-managed biography ${stamp}.`;
  const jobTitle = `Programme Director ${stamp}`;
  const company = `Greenroom Cooperative ${stamp}`;
  const headshot = `organizer-headshot-${stamp}.png`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  const original = await rosterEntry(page, SAM);
  // Uploads belong to the speaker; choosing one for the programme is the organizer action this
  // journey drives. Seed a real speaker-owned image, then return to the organizer before opening
  // the editor.
  await page.request.post("/api/demo-session", { data: { persona: "speaker" } });
  const uploaded = await page.request.post("/api/speaker-assets", {
    data: {
      profileId: SAM,
      name: headshot,
      contentType: "image/png",
      contentBase64: PNG_1X1,
    },
  });
  expect(
    uploaded.ok(),
    `uploading the speaker-owned headshot failed: ${await uploaded.text()}`,
  ).toBe(true);
  const headshotId = ((await uploaded.json()) as { asset: { id: string } }).asset.id;
  await page.request.post("/api/demo-session", { data: { persona: "organizer" } });
  await page.goto(SESSIONS);

  const roster = page.getByRole("region", { name: "Speakers", exact: true });
  await roster.getByRole("button", { name: "Edit profile for Sam Speaker" }).click();
  const editor = page.getByRole("region", { name: "Edit Sam Speaker" });
  await expect(editor).toContainText(`Version ${original.version}`);
  await editor.getByLabel("Bio").fill(bio);
  await editor.getByLabel("Job title").fill(jobTitle);
  await editor.getByLabel("Company").fill(company);
  await editor.getByRole("button", { name: "Save canonical profile" }).click();
  await expect(editor.getByRole("status")).toContainText("canonical profile was saved");
  await editor.getByRole("button", { name: `Use ${headshot}` }).click();
  await expect(editor.getByRole("status")).toContainText("headshot was selected");

  // The speaker sees both organizer writes in the same controls they use to edit them. The
  // switch is only complete once the demo-session request and the shell reload behind it have
  // finished; navigating sooner races that request and lets the stale organizer session win the
  // portal load, which is why the sidebar's own speaker destination is waited for.
  await switchPersona(page, "Speaker");
  await expect(page.getByRole("link", { name: /Speaker portal/ })).toBeVisible();
  await page.goto(PORTAL);
  const speakerProfile = page.getByRole("region", { name: "Your public profile" });
  await expect(speakerProfile.getByLabel("Bio")).toHaveValue(bio);
  await expect(speakerProfile.getByLabel("Job title")).toHaveValue(jobTitle);
  await expect(speakerProfile.getByLabel("Company")).toHaveValue(company);
  const privateUploads = page.getByRole("region", { name: "Private uploads" });
  await expect(privateUploads).toContainText(headshot);
  const chosenPhoto = privateUploads.locator("img.photo-preview");
  await expect(chosenPhoto).toHaveAttribute("src", `/api/speaker-assets/${headshotId}`);
  await expect.poll(() => chosenPhoto.evaluate(decoded)).toBeGreaterThan(0);

  // Publication reads the same canonical row; no organizer-only copy is involved.
  await page.request.post("/api/demo-session", { data: { persona: "organizer" } });
  const publishHeadshot = await page.request.post(`/api/speaker-assets/${headshotId}/publish`);
  expect(
    publishHeadshot.ok(),
    `publishing the organizer headshot failed: ${await publishHeadshot.text()}`,
  ).toBe(true);
  await publishEvent(page);
  const response = await page.request.get(`/api/public/events/${SLUG}`);
  expect(response.ok()).toBe(true);
  const projection = (await response.json()) as {
    projection: {
      speakers: {
        name: string;
        bio: string;
        jobTitle?: string;
        organization: string;
        photoUrl?: string;
      }[];
    };
  };
  expect(projection.projection.speakers.find(({ name }) => name === "Sam Speaker")).toMatchObject({
    bio,
    jobTitle,
    organization: company,
    photoUrl: `/api/speaker-assets/${headshotId}`,
  });

  // Restore both canonical and public state so a shared-fixture rerun starts where the seed does.
  let changed = await rosterEntry(page, SAM);
  const cleared = await page.request.delete(`/api/speaker-profiles/${SAM}/photo`, {
    data: { expectedVersion: changed.version },
  });
  expect(cleared.ok(), `clearing the organizer headshot failed: ${await cleared.text()}`).toBe(
    true,
  );
  changed = await rosterEntry(page, SAM);
  if (original.photoAssetId) {
    const restorePhoto = await page.request.put(`/api/speaker-profiles/${SAM}/photo`, {
      data: { assetId: original.photoAssetId, expectedVersion: changed.version },
    });
    expect(
      restorePhoto.ok(),
      `restoring Sam's original headshot failed: ${await restorePhoto.text()}`,
    ).toBe(true);
    changed = await rosterEntry(page, SAM);
  }
  expect((await page.request.delete(`/api/speaker-assets/${headshotId}`)).status()).toBe(204);
  const restored = await page.request.patch(`/api/speaker-profiles/${SAM}`, {
    data: {
      expectedVersion: changed.version,
      name: original.name,
      pronouns: original.pronouns,
      jobTitle: original.jobTitle,
      organization: original.organization,
      bio: original.bio,
      socialLinks: original.socialLinks ?? {},
    },
  });
  expect(restored.ok(), `restoring Sam's profile failed: ${await restored.text()}`).toBe(true);
  await publishEvent(page);
});

/*
 * The portal invitation an organizer sends on purpose (#189).
 *
 * A speaker was written to exactly once — when their proposal was accepted — under a key that
 * names the *person*, `speaker-invite:{event}:{profile}`. Deduplication then did what it was built
 * to do and refused every later invitation to them, so a speaker who deleted that mail had no way
 * back into the portal and no organizer had a control to offer them. The second press below is the
 * whole point of this journey: it has to produce a second delivery, at the next occurrence of this
 * profile's own counter, while acceptance's welcome stays exactly as idempotent as it always was.
 *
 * Nothing here is hard-coded to `n1` and `n2`. `invitations_sent` is durable, this suite shares one
 * mutable fixture, and there is no un-invite for a journey to hand back with — so it reads where
 * the numbering stands before it presses anything and asserts that the presses are the *next* two
 * occurrences. Straight out of `npm run reset` those are literally 1 and 2; on the fifth run of the
 * day they are not, and a spec insisting otherwise would be asserting that somebody had reset the
 * database rather than that the product works (issue #72's discipline).
 */
test("an organizer invites a speaker into the portal, and can invite the same speaker again", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  const before = (await rosterEntry(page, SAM)).invitationsSent ?? 0;
  const jordanBefore = (await rosterEntry(page, JORDAN)).invitationsSent ?? 0;

  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Speakers" })).toBeVisible();
  // Exact: an accessible name matches by substring, and the operations panel below this one
  // carries a region called "Import speakers".
  const roster = page.getByRole("region", { name: "Speakers", exact: true });
  const samRow = roster.getByRole("row", { name: /Sam Speaker/ });
  const tickSam = roster.getByRole("checkbox", {
    name: "Select Sam Speaker for a portal invitation",
  });

  // Nobody ticked: the control names no count and cannot be pressed, because "Invite 0 speakers"
  // reads as an offer to do nothing rather than as "choose somebody first".
  await expect(roster.getByRole("button", { name: "Invite to the portal" })).toBeDisabled();

  await tickSam.check();
  await roster.getByRole("button", { name: "Invite 1 speaker" }).click();
  await expect(roster.getByRole("status")).toContainText("1 invitation queued");
  /*
   * The roster's own count, which is the organizer's answer to "have we written to this person",
   * and it is also what makes the next press a *second* press. The announcement says the same
   * words both times and lingers for six seconds, so a journey that only re-read the message could
   * pass having pressed the button once and watched the first answer twice.
   */
  await expect(samRow).toContainText(invitations(before + 1));

  await tickSam.check();
  await roster.getByRole("button", { name: "Invite 1 speaker" }).click();
  await expect(roster.getByRole("status")).toContainText("1 invitation queued");
  await expect(samRow).toContainText(invitations(before + 2));

  // Delivery state, from the domain that owns it.
  const history = await invitationsFor(page, SAM);
  const numbered = history.filter(({ idempotencyKey }) => /:n\d+$/.test(idempotencyKey));
  const first = numbered.find(({ idempotencyKey }) => idempotencyKey.endsWith(`:n${before + 1}`));
  const second = numbered.find(({ idempotencyKey }) => idempotencyKey.endsWith(`:n${before + 2}`));
  expect(first, `the first press should have queued occurrence ${before + 1}`).toBeDefined();
  expect(second, `the second press should have queued occurrence ${before + 2}`).toBeDefined();
  // Two messages, not one message reported twice — which is exactly what the old key produced.
  expect(first?.id).not.toBe(second?.id);
  for (const delivery of [first, second]) {
    expect(delivery?.recipientRef).toBe("sam@example.test");
    // Filed under what it is. An operator reading the delivery log for "what have we sent this
    // person" must not find an invitation shelved under the task-reminder trigger.
    expect(delivery?.triggerType).toBe("speaker.invited");
    // A real message rather than an empty envelope: the template rendered against this speaker.
    expect(delivery?.renderedBody).toContain("Sam Speaker");
  }
  // The retained payload says which invitation it was, so the history stays readable months later
  // without re-deriving the number from the key.
  expect(first?.payload.invitationNumber).toBe(before + 1);
  expect(second?.payload.invitationNumber).toBe(before + 2);
  // No occurrence is ever handed out twice: two presses sharing a number would converge into one
  // delivery, and the organizer who pressed second would be told the speaker "has already been
  // invited" about a message they never asked for.
  expect(new Set(numbered.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(numbered.length);
  // And acceptance's welcome is untouched: still exactly one delivery on the unnumbered key it has
  // always had. That is what stops "here is your portal again" converging into "your talk is in".
  expect(history.filter(({ idempotencyKey }) => !/:n\d+$/.test(idempotencyKey))).toHaveLength(1);

  /*
   * Two speakers in one press. The occurrence belongs to the profile rather than to the action, so
   * these two are at their own numbers and not at a shared one — and both are reported, which is
   * the property that stops a selection quietly reaching fewer people than were ticked.
   */
  await tickSam.check();
  await roster
    .getByRole("checkbox", { name: "Select Jordan Bell for a portal invitation" })
    .check();
  await roster.getByRole("button", { name: "Invite 2 speakers" }).click();
  await expect(roster.getByRole("status")).toContainText("2 invitations queued");
  await expect(samRow).toContainText(invitations(before + 3));
  await expect(roster.getByRole("row", { name: /Jordan Bell/ })).toContainText(
    invitations(jordanBefore + 1),
  );
  expect(
    (await invitationsFor(page, JORDAN)).some(({ idempotencyKey }) =>
      idempotencyKey.endsWith(`:n${jordanBefore + 1}`),
    ),
    "Jordan Bell's invitation should be numbered on their own profile, not on Sam's",
  ).toBe(true);

  /*
   * The other clause of that same announcement — "no address for <name>" — is deliberately not
   * driven here, and the reason belongs in the file rather than in somebody's memory. An
   * invitation is addressed from `speaker_profiles.email`, and every path the product has for
   * creating a profile — accepting a proposal, importing a CSV, converting a prospect — needs
   * an address, so no speaker this fixture can hold is unreachable *to an invitation*. Jordan
   * Bell has no address on their *identity*, which is a different column feeding a different
   * audience: `communications.spec.ts` asserts the naming there, on the surface that resolves
   * through identity, where an unreachable speaker is real.
   */
});
