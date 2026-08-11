// @acceptance ACC-CRM
import { expect, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
/** The same organization's second seeded event: staffed by the organizer alone. */
const OTHER_EVENT_ID = "00000000-0000-4000-8000-000000000002";
const SEEDED_PROSPECT = "50000000-0000-4000-8000-000000000001";
const CRM = `/speakers?event=${EVENT_ID}`;

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
  // Refused before any write: the neighbouring event's pipeline is still empty.
  const otherPipeline = await page.request.get(`/api/events/${OTHER_EVENT_ID}/prospects`);
  expect((await otherPipeline.json()).prospects).toHaveLength(0);

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
