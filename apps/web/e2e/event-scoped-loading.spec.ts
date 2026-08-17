// @acceptance ACC-AGENDA ACC-PUBLIC ACC-REVIEW ACC-SPEAKER
import { switchEvent } from "./controls";
import { expect, type Page, test } from "./fixtures";

/**
 * The first paint of a workspace, which is now a skeleton rather than a sentence.
 *
 * The wait is announced by one live region carrying the label; the bars beside it are decoration
 * and stay out of the accessibility tree. So the wait is found by the region's name, not by text
 * on the page — there is none.
 */
const loading = (page: Page, what: string) => page.getByRole("status", { name: what });

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const WORKSHOP_EVENT = "00000000-0000-4000-8000-000000000002";
const WORKSHOP_PROPOSAL = "10000000-0000-4000-8000-000000000003";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

test("an older event response cannot replace the newly selected event", async ({ page }) => {
  await signIn(page);
  await page.route(`**/api/events/${DEMO_EVENT}/content`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.continue();
  });
  await page.route(`**/api/events/${WORKSHOP_EVENT}/content`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });

  await page.goto(`/schedule?event=${DEMO_EVENT}&tab=sessions`);
  const wait = loading(page, "Loading the sessions and speakers workspace.");
  await expect(wait).toBeVisible();
  await switchEvent(page, "Greenroom Workshop Day");
  await expect(wait).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
  await expect(page.getByText("Designing the calm conference")).toHaveCount(0);
  await page.waitForTimeout(1_100);
  await expect(page.getByText("Designing the calm conference")).toHaveCount(0);
});

test("filtering and a bulk reload preserve rubric typing and selection", async ({ page }) => {
  await signIn(page);
  await page.request.put(`/api/events/${WORKSHOP_EVENT}/review/statuses`, {
    data: {
      statuses: [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "under_review", label: "Under review", sortOrder: 1 },
      ],
    },
  });
  try {
    await page.goto(`/abstracts?event=${WORKSHOP_EVENT}`);
    await page.getByText("Evaluation setup").click();
    const criterion = page.getByLabel("Criterion 1 name");
    await criterion.fill("Relevance to attendees");
    await page.getByRole("checkbox", { name: "Select Workshop proposal" }).check();

    /*
     * Through a filter that matches nothing and back again.
     *
     * The selection bar now lives with the rows it acts on, so a tab with none of them draws no
     * bar at all — controls that would operate on abstracts nobody can see are worse than no
     * controls. What has to survive the round trip is the state, and that is what is asserted on
     * the way back rather than on the empty tab.
     */
    await page.getByRole("tab", { name: /^Accepted/ }).click();
    await expect(page.getByRole("heading", { name: /No abstracts/ })).toBeVisible();
    await expect(criterion).toHaveValue("Relevance to attendees");
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.getByLabel("Move selection to").selectOption("under_review");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("tabpanel").getByRole("status")).toContainText(
      "moved to Under review",
    );
    await expect(criterion).toHaveValue("Relevance to attendees");
    await expect(page.getByText("1 selected")).toBeVisible();
  } finally {
    await page.request.post(`/api/events/${WORKSHOP_EVENT}/review/transitions`, {
      data: { proposalIds: [WORKSHOP_PROPOSAL], toStatus: "submitted" },
    });
    await page.request.put(`/api/events/${WORKSHOP_EVENT}/review/statuses`, {
      data: { statuses: [{ key: "submitted", label: "Submitted", sortOrder: 0 }] },
    });
  }
});

test("switching public events clears the previous event's live CFP while loading", async ({
  page,
}) => {
  const projectionResponse = await page.request.get("/api/public/events/greenroom-demo-summit");
  const projection = await projectionResponse.json();
  const cfpResponse = await page.request.get(`/api/public/events/${DEMO_EVENT}/cfp`);
  const cfp = await cfpResponse.json();
  const secondEventId = "00000000-0000-4000-8000-000000000099";

  await page.route("**/api/public/events/event-scope-test", async (route) => {
    await route.fulfill({
      json: {
        ...projection,
        projection: {
          ...projection.projection,
          event: {
            ...projection.projection.event,
            eventId: secondEventId,
            slug: "event-scope-test",
            name: "Event Scope Test",
          },
          cfp: { ...projection.projection.cfp, title: "Second event CFP" },
        },
      },
    });
  });
  await page.route(`**/api/public/events/${secondEventId}/cfp`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({
      json: {
        ...cfp,
        cfp: {
          ...cfp.cfp,
          eventId: secondEventId,
          title: "Second event CFP",
          fields: [{ ...cfp.cfp.fields[0], id: "second-title", label: "Second event title" }],
        },
      },
    });
  });

  await page.goto("/events/greenroom-demo-summit/cfp");
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState({}, "", "/events/event-scope-test/cfp");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("textbox", { name: /Proposal title/ })).toHaveCount(0, {
    timeout: 300,
  });
  await expect(page.getByRole("heading", { name: "Second event CFP" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Second event title/ })).toBeVisible();
});

test("opening an event with no agenda performs no write until Create agenda", async ({ page }) => {
  await signIn(page);
  const agendaFixture = await (await page.request.get(`/api/events/${DEMO_EVENT}/agenda`)).json();

  const writes: string[] = [];
  await page.route(`**/api/events/${WORKSHOP_EVENT}/agenda`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "NOT_FOUND",
            message: "Agenda not found.",
            correlationId: "event-scope-test",
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        ...agendaFixture,
        agenda: { ...agendaFixture.agenda, eventId: WORKSHOP_EVENT },
      },
    });
  });
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/agenda"))
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(`/schedule?event=${WORKSHOP_EVENT}&tab=agenda`);
  await expect(page.getByText("No agenda yet — create the first room and track")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add room" })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Create agenda" }).click();
  // Exact: an empty board offers the same drawer from its own empty state, named for the job —
  // "Set up rooms and times" — and a substring match resolves to both controls.
  await expect(page.getByRole("button", { name: "Rooms and times", exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain("PUT");
});
