// @acceptance ACC-CRM
/*
 * The directory is the CRM's only cross-event surface, so the properties worth pinning in the
 * browser are the ones that make it cross-event rather than a second pipeline: one row for a
 * person who appears at two events, filters that are sent to the server rather than applied to a
 * page of results, a saved view that reopens by its definition, and a refusal rendered in place
 * of the list when the server says this identity may not read the organization.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmDirectoryWorkspace } from "../src/CrmDirectoryWorkspace";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const adaId = "51000000-0000-4000-8000-000000000001";
const morganId = "51000000-0000-4000-8000-000000000002";
const segmentId = "52000000-0000-4000-8000-000000000001";

const contact = (overrides: Record<string, unknown> = {}) => ({
  id: adaId,
  organizationId,
  name: "Dr. Ada Rivera",
  email: "ada@example.test",
  company: "Northwind Access",
  title: "Principal Engineer",
  notes: "Prefers a morning slot.",
  source: "prospect",
  mergedIntoId: null,
  tags: ["keynote"],
  fields: [{ key: "topic", value: "Inclusive event design" }],
  aliases: [],
  events: [
    {
      eventId,
      prospectId: "50000000-0000-4000-8000-000000000001",
      stage: "contacted",
      speakerId: null,
      convertedAt: null,
      linkedAt: "2026-08-01T12:00:00.000Z",
    },
    {
      eventId: otherEventId,
      prospectId: "50000000-0000-4000-8000-000000000003",
      stage: "identified",
      speakerId: null,
      convertedAt: null,
      linkedAt: "2026-08-07T12:00:00.000Z",
    },
  ],
  activities: [
    {
      id: "71000000-0000-4000-8000-000000000001",
      kind: "note",
      summary: "Met at the accessibility summit",
      private: true,
      occurredAt: "2026-08-01T12:00:00.000Z",
      actorId: "seed-organizer",
    },
  ],
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
  ...overrides,
});

const morgan = () =>
  contact({
    id: morganId,
    name: "Morgan Chen",
    email: "morgan@example.test",
    company: "Southwind Labs",
    title: "Staff Engineer",
    notes: null,
    tags: ["workshop"],
    fields: [],
    events: [],
    activities: [],
  });

const dashboard = (overrides: Record<string, unknown> = {}) => ({
  contacts: 2,
  contactsInMultipleEvents: 1,
  convertedContacts: 0,
  duplicateGroups: 0,
  segments: 1,
  imported: 0,
  byStage: [
    { stage: "contacted", contacts: 1 },
    { stage: "identified", contacts: 1 },
  ],
  topCompanies: [
    { company: "Northwind Access", contacts: 1 },
    { company: "Southwind Labs", contacts: 1 },
  ],
  ...overrides,
});

const segment = {
  id: segmentId,
  organizationId,
  name: "Keynote shortlist",
  filters: { tags: ["keynote"] },
  createdAt: "2026-08-04T12:00:00.000Z",
  createdBy: "seed-organizer",
};

const owners = [
  { id: "seed-organizer", name: "Olivia Organizer" },
  { id: "seed-reviewer", name: "Ravi Reviewer" },
];

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Sent = { url: string; method: string; body: Record<string, unknown> };

function stubApi(routes: (url: string, method: string) => Promise<Response> | undefined) {
  const sent: Sent[] = [];
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url}`);
      if (method !== "GET")
        sent.push({
          url,
          method,
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
      return routes(url, method) ?? jsonResponse({});
    }),
  );
  return { sent, seen };
}

/** The reads the workspace makes on every load, answered from one fixture. */
const directoryRoutes =
  (contacts: unknown[], filters: Record<string, unknown> = {}) =>
  (url: string) => {
    if (url.includes("/prospects/owners")) return jsonResponse({ owners });
    if (url.includes("/crm/dashboard")) return jsonResponse(dashboard());
    if (url.includes("/crm/segments")) return jsonResponse({ segments: [segment] });
    if (url.includes("/crm/contacts")) return jsonResponse({ contacts, filters });
    return undefined;
  };

const mount = () =>
  render(
    <CrmDirectoryWorkspace
      organizationId={organizationId}
      eventId={eventId}
      eventName="Greenroom Demo Summit"
      ownerId="seed-organizer"
    />,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the organization-wide speaker directory", () => {
  it("shows a contact once with every event it belongs to", async () => {
    stubApi(directoryRoutes([contact(), morgan()]));
    mount();

    const row = await screen.findByRole("row", { name: /Dr\. Ada Rivera/ });
    // One row, not one per event, and the count is what says she is at two.
    expect(screen.getAllByRole("button", { name: "Dr. Ada Rivera" })).toHaveLength(1);
    expect(within(row).getByText("2")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Dr. Ada Rivera" }));
    const history = await screen.findByRole("region", { name: "Event history" });
    // The selected event is named; the other is still listed, because the directory's answer is
    // not scoped to whichever event the shell has open.
    expect(within(history).getByText("Greenroom Demo Summit")).toBeTruthy();
    expect(within(history).getByText(otherEventId)).toBeTruthy();
    expect(within(history).getByText("contacted")).toBeTruthy();
    expect(within(history).getByText("identified")).toBeTruthy();
  });

  it("sends multi-criteria filters to the server and clears them back to everybody", async () => {
    const { seen } = stubApi(directoryRoutes([contact()], { company: "Northwind Access" }));
    mount();
    await screen.findByRole("button", { name: "Dr. Ada Rivera" });

    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Northwind Access" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "keynote, ai" } });
    fireEvent.change(screen.getByLabelText("Custom field"), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() =>
      expect(
        seen.some(
          (request) =>
            request.includes("company=Northwind+Access") &&
            request.includes("tags=keynote%2Cai") &&
            request.includes("fieldKey=topic"),
        ),
      ).toBe(true),
    );

    // Clearing sends no criteria at all, rather than empty ones.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0] as HTMLElement);
    await waitFor(() =>
      expect(
        seen.filter((request) => request.endsWith(`/crm/contacts`)).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Company").value).toBe("");
  });

  it("reopens a saved view by its identity, and saves the current filters as a new one", async () => {
    const { seen, sent } = stubApi((url, method) => {
      if (url.includes("/crm/segments") && method === "POST")
        return jsonResponse({ segment: { ...segment, name: "Design shortlist" } });
      return directoryRoutes([contact()])(url);
    });
    mount();
    await screen.findByRole("button", { name: "Dr. Ada Rivera" });

    fireEvent.change(screen.getByLabelText("Saved views"), { target: { value: segmentId } });
    // Reopening sends the segment's id, so the server resolves the stored definition rather than
    // trusting a client-rebuilt copy of it.
    await waitFor(() =>
      expect(seen.some((request) => request.includes(`segmentId=${segmentId}`))).toBe(true),
    );
    // And its definition is rendered back into the controls.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Tags").value).toBe("keynote"),
    );

    fireEvent.change(screen.getByLabelText("Save this view as"), {
      target: { value: "Design shortlist" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    await waitFor(() =>
      expect(sent.find((request) => request.url.endsWith("/crm/segments"))?.body).toEqual({
        name: "Design shortlist",
        filters: { tags: ["keynote"] },
      }),
    );
  });

  it("sources a contact into the selected event through the conversion boundary", async () => {
    const { sent } = stubApi((url, method) => {
      if (url.includes("/events") && method === "POST")
        return jsonResponse(
          {
            contact: contact(),
            prospect: {
              id: "50000000-0000-4000-8000-000000000001",
              eventId,
              name: "Dr. Ada Rivera",
              stage: "converted",
              ownerId: "seed-organizer",
              nextAction: null,
              nextActionAt: null,
              contacts: [],
              activities: [],
              speakerId: "40000000-0000-4000-8000-000000000001",
              convertedAt: "2026-08-11T12:00:00.000Z",
              createdAt: "2026-08-11T12:00:00.000Z",
              updatedAt: "2026-08-11T12:00:00.000Z",
            },
          },
          201,
        );
      return directoryRoutes([contact()])(url);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dr. Ada Rivera" }));

    // The owner control offers what identity-access says the event's staff is, exactly as the
    // pipeline's does — the directory does not invent a second vocabulary for it.
    const owner = await screen.findByLabelText<HTMLSelectElement>(/^Owner on/);
    expect([...owner.options].map((option) => option.textContent)).toEqual([
      "Olivia Organizer (you)",
      "Ravi Reviewer",
    ]);
    fireEvent.click(screen.getByLabelText("Convert to a speaker straight away"));
    fireEvent.click(screen.getByRole("button", { name: /Add to Greenroom Demo Summit/ }));

    await waitFor(() =>
      expect(sent.find((request) => request.url.endsWith("/events"))?.body).toEqual({
        eventId,
        ownerId: "seed-organizer",
        convert: true,
      }),
    );
    expect(await screen.findByText(/is now a speaker on Greenroom Demo Summit/)).toBeTruthy();
  });

  it("previews outreach before sending it, and names the delivery count afterwards", async () => {
    const { sent } = stubApi((url, method) => {
      if (url.endsWith("/crm/outreach/preview") && method === "POST")
        return jsonResponse({
          eventId,
          templateKey: "speaker-invite",
          recipients: [{ contactId: adaId, name: "Dr. Ada Rivera", email: "ada@example.test" }],
        });
      if (url.endsWith("/crm/outreach") && method === "POST")
        return jsonResponse({
          eventId,
          templateKey: "speaker-invite",
          sent: [
            {
              contactId: adaId,
              name: "Dr. Ada Rivera",
              email: "ada@example.test",
              deliveryId: "delivery-1",
            },
          ],
        });
      return directoryRoutes([contact(), morgan()])(url);
    });
    mount();
    await screen.findByRole("button", { name: "Dr. Ada Rivera" });

    fireEvent.click(screen.getByLabelText("Select Dr. Ada Rivera for outreach"));
    fireEvent.click(screen.getByRole("button", { name: "Preview outreach" }));
    // Nothing is sent by a preview: the send control only appears once one has been resolved.
    await waitFor(() => expect(screen.getByRole("button", { name: /Send to 1/ })).toBeTruthy());
    expect(sent.filter((request) => request.url.endsWith("/crm/outreach"))).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Send to 1/ }));
    await waitFor(() =>
      expect(sent.find((request) => request.url.endsWith("/crm/outreach"))?.body).toEqual({
        eventId,
        templateKey: "speaker-invite",
        contactIds: [adaId],
      }),
    );
    expect(await screen.findByText(/Queued 1 message through communications/)).toBeTruthy();
  });

  it("renders the server's refusal in place of the directory rather than an empty list", async () => {
    stubApi((url) => {
      if (url.includes("/crm/contacts"))
        return jsonResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "Actor lacks crm:manage inside this organization.",
              correlationId: "correlation-1",
            },
          },
          403,
        );
      return directoryRoutes([])(url);
    });
    mount();

    // The rule needs event-to-organization data the browser does not hold, so the workspace
    // shows what the server said instead of guessing that the list is simply empty.
    expect(
      await screen.findByRole("heading", { name: "The speaker directory could not be loaded" }),
    ).toBeTruthy();
    expect(screen.getByText(/Actor lacks crm:manage inside this organization/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
