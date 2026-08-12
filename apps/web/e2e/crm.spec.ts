// @acceptance ACC-CRM
import { expect, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
/** The same organization's second seeded event: staffed by the organizer alone. */
const OTHER_EVENT_ID = "00000000-0000-4000-8000-000000000002";
/** An event of a different organization entirely, which this organizer does not run. */
const OUTSIDE_EVENT_ID = "00000000-0000-4000-8000-000000000099";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const OUTSIDE_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000020";
const SEEDED_PROSPECT = "50000000-0000-4000-8000-000000000001";
const SEEDED_CONTACT = "51000000-0000-4000-8000-000000000001";
const CRM = `/speakers?event=${EVENT_ID}`;
const DIRECTORY = `/speaker-directory?event=${EVENT_ID}`;

const signIn = async (page: import("@playwright/test").Page, persona = "organizer") => {
  await page.goto("/");
  await page.getByRole("button", { name: `Continue as ${persona}` }).click();
  // The click posts the demo session; navigating before its cookie lands loads the workspace
  // unauthenticated and the shell bounces to the sign-in surface.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
};

test("organizer works the pipeline, adds a prospect, and converts it", async ({ page }) => {
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
  const futureLocal = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads the CRM
  // unauthenticated and the shell bounces to the sign-in surface.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(CRM);
  await expect(page.getByRole("heading", { name: "Speaker CRM", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prospect pipeline" })).toBeVisible();

  // Stage counts are readable before a stage is chosen.
  const pipeline = page.getByRole("table");
  await expect(pipeline.getByRole("button", { name: "Dr. Ada Rivera" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Overdue/ })).toBeVisible();

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(page.getByText("Follow up on keynote topic")).toBeVisible();
  await page.getByRole("tab", { name: /^All/ }).click();

  const name = `Browser Prospect ${Date.now()}`;
  await page.getByRole("button", { name: "New prospect" }).click();
  await page.getByLabel("Prospect name").fill(name);
  await page
    .getByLabel("Contact email", { exact: true })
    .fill(`browser-${Date.now()}@example.test`);
  // The owner control is a select over the event's staff, served by identity-access: free text
  // used to reach the owner_id foreign key and surface as a 500.
  const newOwner = page.getByLabel("Owner", { exact: true });
  await expect(newOwner).toHaveRole("combobox");
  await expect(newOwner.locator("option")).toHaveText(["Olivia Organizer (you)", "Ravi Reviewer"]);
  // `seed-speaker` holds the speaker role on this event and is therefore not offerable.
  await expect(newOwner.locator("option", { hasText: "Sam Speaker" })).toHaveCount(0);
  await page.getByLabel("First action due").fill("2026-08-01T12:00");
  await page.getByRole("button", { name: "Add prospect" }).click();
  await expect(page.getByText(`${name} added to the pipeline`)).toBeVisible();

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(pipeline.getByRole("button", { name })).toBeVisible();
  await page.getByRole("tab", { name: /^All/ }).click();

  // Open the detail panel and move the prospect along its pipeline.
  await pipeline.getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByLabel("Stage", { exact: true }).selectOption("engaged");
  // A reviewer on this event is assignable; the assignment grants them no CRM access.
  await page.getByLabel("Owner", { exact: true }).selectOption({ label: "Ravi Reviewer" });
  await page.getByLabel("Next action", { exact: true }).fill("Confirm session outline");
  await page.getByLabel("Next action due").fill(futureLocal);
  await page.getByLabel("Private note").fill("Available after 2pm");
  await page.getByRole("button", { name: "Save prospect" }).click();
  await expect(page.getByText("Available after 2pm")).toBeVisible();
  // One save, two timeline entries: the transition the server synthesized and the note.
  const timeline = page.getByRole("region", { name: "Activity timeline" });
  await expect(timeline.getByText("identified → engaged")).toBeVisible();
  await expect(timeline.getByText("identified → engaged")).toHaveCount(1);
  // The reassignment reached the pipeline: this prospect's row now names the reviewer as
  // its owner. Scoped to the row this run created — the pipeline is a shared fixture and
  // every earlier run left a prospect owned by the same reviewer behind.
  await expect(pipeline.getByRole("row", { name: new RegExp(name) })).toContainText(
    "Ravi Reviewer",
  );

  // Saving again without moving the stage records nothing further.
  await page.getByLabel("Next action", { exact: true }).fill("Confirm the outline");
  await page.getByRole("button", { name: "Save prospect" }).click();
  await expect(page.getByText("Confirm the outline").first()).toBeVisible();
  await expect(timeline.getByText("identified → engaged")).toHaveCount(1);

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(pipeline.getByRole("button", { name })).toHaveCount(0);
  await page.getByRole("tab", { name: /^All/ }).click();

  await page.getByText("Add another contact").click();
  await page.getByLabel("Contact name").fill("Speaker assistant");
  await page.getByLabel("Additional contact email").fill("assistant@example.test");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("link", { name: "assistant@example.test" })).toBeVisible();

  // Conversion is confirmed before it runs, then reported.
  await page.getByRole("button", { name: "Convert to speaker" }).click();
  await expect(page.getByText(`Convert ${name}?`)).toBeVisible();
  await page.getByRole("button", { name: `Yes, convert ${name}` }).click();
  await expect(page.getByText(`${name} is now a speaker`)).toBeVisible();
  await expect(page.getByText("Converted prospects are read-only")).toBeVisible();
});

test("an owner the event does not staff is refused as a named field, not a crash", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  const owners = await page.request.get(`/api/events/${EVENT_ID}/prospects/owners`);
  expect(owners.status()).toBe(200);
  const staff = (await owners.json()).owners as { id: string; name: string }[];
  expect(staff.map(({ id }) => id)).toEqual(["seed-organizer", "seed-reviewer"]);

  // The select cannot offer these, but the API is the boundary that has to hold: an unknown
  // id used to reach the owner_id foreign key and return 500 INTERNAL_ERROR, and a
  // speaker-only identity was accepted with 200.
  for (const ownerId of ["not-a-real-user-at-all", "seed-speaker"]) {
    const refused = await page.request.patch(
      `/api/events/${EVENT_ID}/prospects/${SEEDED_PROSPECT}`,
      { data: { ownerId } },
    );
    expect(refused.status()).toBe(400);
    const body = await refused.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.fieldErrors.ownerId).toEqual([
      "Choose an organizer or reviewer assigned to this event.",
    ]);
  }

  expect(staff.some(({ id }) => id === "seed-speaker")).toBe(false);

  // Cross-event negative: `seed-reviewer` reviews event one and nothing else, so the
  // neighbouring event neither offers them nor accepts them as an owner.
  const otherEventOwners = await page.request.get(`/api/events/${OTHER_EVENT_ID}/prospects/owners`);
  expect(otherEventOwners.status()).toBe(200);
  expect(((await otherEventOwners.json()).owners as { id: string }[]).map(({ id }) => id)).toEqual([
    "seed-organizer",
  ]);
  const foreign = await page.request.post(`/api/events/${OTHER_EVENT_ID}/prospects`, {
    data: {
      name: "Cross-event owner",
      ownerId: "seed-reviewer",
      contact: { name: "Cross event", email: "cross-event@example.test" },
    },
  });
  expect(foreign.status()).toBe(400);
  expect((await foreign.json()).error.fieldErrors.ownerId).toEqual([
    "Choose an organizer or reviewer assigned to this event.",
  ]);
  // Refused before any write. The neighbouring event's pipeline holds exactly what the seed put
  // there — the workshop-day prospect that gives the directory its two-event contact — and
  // nothing this refused request tried to add.
  const otherPipeline = await page.request.get(`/api/events/${OTHER_EVENT_ID}/prospects`);
  const otherNames = ((await otherPipeline.json()).prospects as { name: string }[]).map(
    ({ name }) => name,
  );
  expect(otherNames).not.toContain("Cross-event owner");
  expect(otherNames).toContain("Dr. Ada Rivera");

  // The prospect is untouched: a refused reassignment writes nothing.
  const unchanged = await page.request.get(`/api/events/${EVENT_ID}/prospects/${SEEDED_PROSPECT}`);
  expect((await unchanged.json()).prospect.ownerId).toBe("seed-organizer");
});

test("the pipeline searches by contact and explains an empty stage", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads the CRM
  // unauthenticated and the shell bounces to the sign-in surface.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(CRM);

  await page.getByLabel("Search prospects").fill("morgan@example.test");
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toHaveCount(0);

  await page.getByLabel("Search prospects").fill("nobody-matches-this");
  await expect(page.getByRole("heading", { name: "No prospects in this view" })).toBeVisible();
  await page.getByRole("button", { name: "Show every prospect" }).click();
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toBeVisible();
});

test("the directory holds one contact across two events, filters, and saves a view", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(DIRECTORY);
  await expect(page.getByRole("heading", { name: "Speaker directory", level: 1 })).toBeVisible();

  // The claim the directory exists to make: courted for two events, listed once, with both.
  const directory = page.getByRole("table").first();
  const ada = directory.getByRole("row", { name: /Dr\. Ada Rivera/ });
  await expect(ada).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toHaveCount(1);
  await ada.getByRole("button", { name: "Dr. Ada Rivera" }).click();
  const history = page.getByRole("region", { name: "Event history" });
  await expect(history.getByText("Greenroom Demo Summit")).toBeVisible();
  await expect(history.getByText(OTHER_EVENT_ID)).toBeVisible();
  // Notes and custom fields are the profile's, not any one event's.
  await expect(page.getByLabel("Notes")).toHaveValue(/morning slot/);
  await expect(page.getByText("Inclusive event design")).toBeVisible();

  // Multi-criteria filtering, then a clear that goes back to everybody.
  await page.getByLabel("Company").fill("Northwind Access");
  await page.getByLabel("Tags").fill("keynote");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toHaveCount(0);

  await page.getByLabel("Tags").fill("keynote,workshop");
  await page.getByRole("button", { name: "Apply filters" }).click();
  // Every tag, not any: nobody carries both.
  await expect(
    page.getByRole("heading", { name: "No contacts match these filters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toBeVisible();

  // A saved view reopens from its stored definition and its criteria come back into the form.
  await page.getByLabel("Saved views").selectOption({ label: "Design shortlist" });
  await expect(page.getByLabel("Tags")).toHaveValue("design");
  await expect(page.getByRole("button", { name: "Priya Raman" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toHaveCount(0);

  const view = `Keynote ${Date.now()}`;
  await page.getByLabel("Saved views").selectOption({ label: "All contacts" });
  await page.getByLabel("Company").fill("Northwind Access");
  await page.getByLabel("Save this view as").fill(view);
  await page.getByRole("button", { name: "Save this view" }).click();
  await expect(page.getByText(`Saved "${view}" as a reusable view.`)).toBeVisible();
  // Reopening it selects by its definition rather than a frozen membership list.
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toHaveCount(0);
});

test("importing a spreadsheet creates durable contacts and the duplicates it makes can be merged", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(DIRECTORY);

  // The suite runs against a shared fixture, so it brings its own duplicate pair rather than
  // consuming the seeded one — which would make only the first run after a reset meaningful.
  const stamp = Date.now();
  const company = `Dupwind ${stamp}`;
  const csv = [
    "name,email,company,title,tags,field:topic",
    `Import Person,import-${stamp}@example.test,${company},Staff Engineer,imported,platform`,
    `Import Person,import-alt-${stamp}@example.test,${company},Staff Engineer,imported,platform`,
    ",broken@example.test,,,,",
  ].join("\n");

  await page.getByText("Import contacts from a spreadsheet").click();
  await page.getByLabel("File name").fill(`speakers-${stamp}.csv`);
  await page.getByLabel("Paste CSV").fill(csv);
  await page.getByRole("button", { name: "Preview import" }).click();
  // The preview is per row, and the nameless row is refused by name rather than silently dropped.
  await expect(page.getByText("2 to add, 0 to update, 1 refused")).toBeVisible();
  await expect(page.getByText("A name is required.")).toBeVisible();

  await page.getByRole("button", { name: "Import contacts", exact: true }).click();
  await expect(page.getByText("Imported 2 new and updated 0 contacts.")).toBeVisible();
  // Durable: the imported rows are in the directory, findable by their address.
  await page.getByLabel("Search directory").fill(`import-${stamp}@example.test`);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("button", { name: "Import Person" })).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).first().click();

  // Two records, one person: a near duplicate on name and company, with different addresses.
  await page.getByText("Find and merge duplicates").click();
  await page.getByRole("button", { name: "Review duplicates" }).click();
  const merge = page.getByRole("button", {
    name: new RegExp(`Merge into import(-alt)?-${stamp}@`),
  });
  await expect(merge).toHaveCount(1);
  await merge.click();
  await expect(page.getByText(/Merged into Import Person/)).toBeVisible();

  // The merged-away address survives as an alias, so the person is still findable under it.
  await page.getByLabel("Search directory").fill(`import-alt-${stamp}@example.test`);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("button", { name: "Import Person" })).toHaveCount(1);
  await page.getByRole("button", { name: "Import Person" }).click();
  await expect(page.getByText(`import-alt-${stamp}@example.test`)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Activity timeline" }).getByText("merge"),
  ).toBeVisible();
});

test("a directory contact is sourced into an event and reaches communications", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(DIRECTORY);

  const stamp = Date.now();
  await page.getByRole("button", { name: "New contact" }).click();
  await page.getByLabel("Contact name").fill(`Sourced Person ${stamp}`);
  await page.getByLabel("Contact email").fill(`sourced-${stamp}@example.test`);
  await page.getByLabel("Company").last().fill("Eastwind Studio");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText(`Sourced Person ${stamp} added to the directory.`)).toBeVisible();

  const lookup = await page.request.get(
    `/api/organizations/${ORGANIZATION_ID}/crm/contacts?search=sourced-${stamp}@example.test`,
  );
  const contactId = ((await lookup.json()).contacts as { id: string }[])[0]?.id ?? "";
  expect(contactId).not.toBe("");

  await page.getByRole("button", { name: `Sourced Person ${stamp}` }).click();
  // Owner is a select over the event's staff, served by identity-access — the directory does
  // not invent a second vocabulary for it.
  const owner = page.getByLabel(/^Owner on/);
  await expect(owner.locator("option")).toHaveText(["Olivia Organizer (you)", "Ravi Reviewer"]);
  await page.getByLabel("Convert to a speaker straight away").check();
  await page.getByRole("button", { name: /Add to Greenroom Demo Summit/ }).click();
  await expect(page.getByText(`Sourced Person ${stamp} is now a speaker`)).toBeVisible();

  // Exactly one prospect and one speaker, and the CRM provenance is on the prospect.
  const pipeline = await page.request.get(`/api/events/${EVENT_ID}/prospects`);
  const sourced = (
    (await pipeline.json()).prospects as { name: string; speakerId: string | null }[]
  ).filter(({ name }) => name === `Sourced Person ${stamp}`);
  expect(sourced).toHaveLength(1);
  expect(sourced[0]?.speakerId).not.toBeNull();

  // Pressing it again converges rather than creating a second prospect or a second speaker.
  await page.getByRole("button", { name: /Add to Greenroom Demo Summit/ }).click();
  await expect(
    page.getByText(/is now a speaker|is in the Greenroom Demo Summit pipeline/),
  ).toBeVisible();
  const again = await page.request.get(`/api/events/${EVENT_ID}/prospects`);
  expect(
    ((await again.json()).prospects as { name: string }[]).filter(
      ({ name }) => name === `Sourced Person ${stamp}`,
    ),
  ).toHaveLength(1);

  // Bulk outreach: previewed, then sent, and observable as a communications delivery.
  await page.getByLabel(`Select Sourced Person ${stamp} for outreach`).check();
  await page.getByText("Send outreach through communications").click();
  await page.getByRole("button", { name: "Preview outreach" }).click();
  await expect(page.getByText("1 recipient would be contacted.")).toBeVisible();
  await page.getByRole("button", { name: /Send to 1/ }).click();
  await expect(page.getByText("Queued 1 message through communications.")).toBeVisible();

  // Delivery history is ordered oldest first and the fixture accumulates, so the page this
  // send landed on is the last one — walk the cursor rather than assuming it is the first.
  let cursor: string | null = null;
  let recipients: string[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const url = `/api/communications/history?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}&limit=50${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const response = await page.request.get(url);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      history: { delivery: { recipientRef: string } }[];
      nextCursor: string | null;
    };
    recipients = [...recipients, ...body.history.map(({ delivery }) => delivery.recipientRef)];
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  expect(recipients).toContain(`crm-contact:${contactId}`);
});

test("the directory refuses every identity outside this organization's CRM", async ({ page }) => {
  await signIn(page, "reviewer");
  // Staffed on this organization's event, and holds no `crm:manage` anywhere: the API refuses
  // and the workspace is not in this persona's navigation at all.
  const reviewerRead = await page.request.get(`/api/organizations/${ORGANIZATION_ID}/crm/contacts`);
  expect(reviewerRead.status()).toBe(403);
  await page.goto(DIRECTORY);
  await expect(page.getByRole("heading", { name: "Speaker directory", level: 1 })).toHaveCount(0);

  await signIn(page);
  // The organizer holds `crm:manage` and belongs to one organization. Naming another is a
  // refusal, not a 404 that would confirm the organization exists.
  const foreign = await page.request.get(
    `/api/organizations/${OUTSIDE_ORGANIZATION_ID}/crm/contacts`,
  );
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error.code).toBe("FORBIDDEN");

  // And an event of another organization cannot be written to through a directory this
  // organizer may legitimately read.
  const across = await page.request.post(
    `/api/organizations/${ORGANIZATION_ID}/crm/contacts/${SEEDED_CONTACT}/events`,
    { data: { eventId: OUTSIDE_EVENT_ID, ownerId: "seed-organizer" } },
  );
  expect(across.status()).toBe(403);

  // The seeded contact is untouched by the refused write.
  const unchanged = await page.request.get(
    `/api/organizations/${ORGANIZATION_ID}/crm/contacts/${SEEDED_CONTACT}`,
  );
  const events = (await unchanged.json()).contact.events as { eventId: string }[];
  expect(events.map(({ eventId }) => eventId)).toEqual([EVENT_ID, OTHER_EVENT_ID]);
});

test("the organization dashboard counts stored contacts rather than constants", async ({
  page,
}) => {
  await signIn(page);
  const before = await page.request.get(`/api/organizations/${ORGANIZATION_ID}/crm/dashboard`);
  const baseline = await before.json();
  expect(baseline.contacts).toBeGreaterThan(0);
  // The seeded two-event contact is what makes this metric non-zero on a clean fixture.
  expect(baseline.contactsInMultipleEvents).toBeGreaterThan(0);

  const stamp = Date.now();
  const created = await page.request.post(`/api/organizations/${ORGANIZATION_ID}/crm/contacts`, {
    data: { name: `Metric Person ${stamp}`, email: `metric-${stamp}@example.test` },
  });
  expect(created.status()).toBe(201);

  const after = await page.request.get(`/api/organizations/${ORGANIZATION_ID}/crm/dashboard`);
  expect((await after.json()).contacts).toBe(baseline.contacts + 1);

  await page.goto(DIRECTORY);
  await expect(page.getByText("Across every event in this organization")).toBeVisible();
  await expect(page.getByText("Held once, with every history")).toBeVisible();
});
