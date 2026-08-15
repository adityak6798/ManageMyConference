// @acceptance ACC-CFP ACC-PUBLIC ACC-DEMO-SMOKE
/*
 * The seed, asserted before any other spec has touched it.
 *
 * The numeric filename prefix is load-bearing: Playwright loads spec files in path order,
 * and this one has to run first. `cfp.spec.ts` republishes the demo event's call for
 * proposals, which repairs exactly the defect this file exists to catch — a published
 * snapshot that shipped without its `fields`, so the public form rendered no inputs and
 * every public submission answered 500 from a clean reset. Every spec still passed,
 * because the organizer republish had already written a correct snapshot.
 *
 * `apps/api/test/seed-state.integration.test.ts` applies the migrations and the seed in
 * miniflare and asserts the same properties against the owning repositories. This file is
 * deliberately the other half of that: the running Worker, the real HTTP routes, the
 * shared contract schemas the browser client parses with, and an anonymous applicant who
 * completes the form with no organizer having republished anything first.
 *
 * Re-runnable: every assertion here is about a property the seed establishes and no spec
 * removes. `cfp.spec.ts` adds a question to the published form on later runs, so the
 * assertions name the seeded fields that must be present rather than the whole set.
 */
import { cfpResponseSchema, publicEventProjectionSchema } from "@greenroom/contracts";
import { expect, test } from "./fixtures";

/*
 * Public submission is throttled to ten proposals per address per minute per event, and
 * five specs in this suite file one. Each of them presents itself as a different applicant
 * — which is what they are — so a suite run, or two runs back to back, never spends one
 * applicant's whole budget. `clientAddress` (apps/api/src/transport/http/throttle.ts)
 * reads `cf-connecting-ip` first; Cloudflare overwrites that header at the edge, so this
 * cannot be used to dodge the limit anywhere but a local runtime. The addresses are from
 * RFC 5737's documentation range and are one per spec file.
 */
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.1" } });

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const DEMO_SLUG = "greenroom-demo-summit";

/** The fields the seeded call for proposals must publish for the demo to be completable. */
const SEEDED_FIELDS = ["Proposal title", "Abstract", "Your name", "Contact email"];

test("serves a published call for proposals that satisfies the shared contract", async ({
  request,
}) => {
  // `request` is an anonymous API context: no demo session cookie, which is the point.
  const response = await request.get(`/api/public/events/${DEMO_EVENT}/cfp`);
  expect(response.status(), await response.text()).toBe(200);

  // Parsed with the same schema the browser client parses with, so any drift between the
  // Worker's output and the contract fails here rather than as an empty form.
  const parsed = cfpResponseSchema.safeParse(await response.json());
  expect(
    parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  ).toEqual([]);
  if (!parsed.success) return;

  expect(parsed.data.cfp.status).toBe("open");
  const labels = parsed.data.cfp.fields.map((field) => field.label);
  expect(labels).toEqual(expect.arrayContaining(SEEDED_FIELDS));
  // A published field an applicant cannot answer is the same defect in a different shape.
  for (const field of parsed.data.cfp.fields) {
    expect(field.id, "every published field needs an id to key its answer").toBeTruthy();
    expect(field.type, `field ${field.id} needs a type the form can render`).toBeTruthy();
  }
});

test("serves a published public projection that satisfies the shared contract", async ({
  request,
}) => {
  const response = await request.get(`/api/public/events/${DEMO_SLUG}`);
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { projection: unknown };
  const parsed = publicEventProjectionSchema.safeParse(body.projection);
  expect(
    parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  ).toEqual([]);
  if (!parsed.success) return;

  // An evaluator opening the demo has to find an event with something in it. This file runs
  // first and immediately after the reset, so the seeded counts are exact — a projection that
  // silently lost half its programme would pass a `> 0` assertion.
  expect(parsed.data.event.name).toBe("Greenroom Demo Summit");
  expect(parsed.data.sessions.map(({ slug }) => slug).toSorted()).toEqual([
    "accessible-by-default",
    "designing-the-calm-conference",
  ]);
  expect(parsed.data.speakers.map(({ slug }) => slug).toSorted()).toEqual([
    "jordan-bell",
    "sam-speaker",
  ]);
  expect(
    parsed.data.sessions.map(({ slug, room, startsAt }) => ({ slug, room, startsAt })),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        slug: "designing-the-calm-conference",
        room: "Main stage",
        startsAt: "2026-09-01T16:00:00.000Z",
      }),
      expect.objectContaining({
        slug: "accessible-by-default",
        room: "Workshop lab",
        startsAt: "2026-09-02T17:00:00.000Z",
      }),
    ]),
  );
  // Every session names speakers the same snapshot publishes: a dangling slug renders a
  // card with nobody on it.
  const speakerSlugs = new Set(parsed.data.speakers.map(({ slug }) => slug));
  for (const session of parsed.data.sessions)
    for (const slug of session.speakerSlugs) expect(speakerSlugs.has(slug)).toBe(true);
});

test("an applicant completes the seeded form before any organizer has republished it", async ({
  page,
}) => {
  await page.goto(`/events/${DEMO_SLUG}/cfp`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Share your conference story" }),
  ).toBeVisible();

  // The regression this file exists for: a published snapshot with no `fields` renders a
  // form with no inputs at all.
  for (const label of SEEDED_FIELDS) await expect(page.getByLabel(label)).toBeVisible();

  await page.getByLabel("Proposal title").fill("A seeded-form submission");
  await page.getByLabel("Abstract").fill("Filed against the seed, with no organizer republish.");
  await page.getByLabel("Your name").fill("Pat Applicant");
  await page.getByLabel("Contact email").fill("pat.applicant@example.test");
  // Later runs meet the extra question `cfp.spec.ts` publishes; the seed does not ship it.
  if (await page.getByLabel("Experience level").count())
    await page.getByLabel("Experience level").selectOption("Experienced");

  // 201, not the 500 the missing `fields` produced. Asserted on the wire and on screen.
  const created = page.waitForResponse(
    (response) => response.url().includes("/submissions") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit proposal" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByRole("status")).toContainText(/Confirmation: [0-9a-f-]{36}/);
});
