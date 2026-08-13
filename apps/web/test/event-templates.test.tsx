// @acceptance ACC-EVENT-TEMPLATES
/**
 * The template console's three load-bearing promises, at the seam where they can be broken.
 *
 * A preview writes nothing; an apply sends the command the preview resolved rather than
 * whatever the controls hold by then; and a partial application says plainly that the
 * categories that succeeded were not rolled back. Each is asserted against the request the
 * browser actually issued, because each is easy to state in copy and easy to lose in code.
 */
import type { EventTemplateDto, EventTemplateVersionDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTemplatesWorkspace } from "../src/events/EventTemplatesWorkspace";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "123e4567-e89b-12d3-a456-426614174000";
const templateId = "223e4567-e89b-42d3-a456-426614174001";
const versionId = "323e4567-e89b-42d3-a456-426614174002";
const sourceEventId = "423e4567-e89b-42d3-a456-426614174003";

const template = {
  id: templateId,
  organizationId,
  name: "Annual summit starter",
  state: "active" as const,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
};

const version = {
  id: versionId,
  version: 1,
  sourceEventId,
  sourceEventName: "Greenroom Demo Summit",
  createdAt: "2026-08-01T09:00:00.000Z",
  createdBy: "seed-organizer",
  // Null so the fallback stays under test: the resolved-name path has its own case.
  createdByName: null,
  slices: ["cfp"],
};

const identity = {
  templateId,
  templateName: template.name,
  versionId,
  version: 1,
  sourceEventId,
  sourceEventName: version.sourceEventName,
  eventId,
  destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
};

const plan = {
  ...identity,
  slices: [
    {
      key: "cfp",
      label: "CFP form and routing",
      outcome: "copies" as const,
      reason: "Replaces the destination's CFP draft. The live published form is untouched.",
      copies: [{ id: "title", label: "Field: Proposal title" }],
      excludes: [{ id: "submissions", label: "Submitted proposals and their answers" }],
      incompatible: [{ id: "route-1", label: "Routing rule to “shortlisted”" }],
    },
    {
      key: "communications",
      label: "Message and reminder templates",
      outcome: "skipped" as const,
      reason: "Already shared at the organization — nothing to copy.",
      copies: [],
      excludes: [],
      incompatible: [],
    },
  ],
};

/** One category wrote, one failed: the shape the non-rollback guarantee exists for. */
const partial = {
  ...identity,
  appliedAt: "2027-01-05T12:00:00.000Z",
  outcome: "partial" as const,
  slices: [
    {
      key: "cfp",
      label: "CFP form and routing",
      outcome: "applied" as const,
      reason: "Replaced the destination's CFP draft.",
      applied: [{ id: "title", label: "Field: Proposal title" }],
      incompatible: [],
    },
    {
      key: "agenda",
      label: "Rooms and time slots",
      outcome: "failed" as const,
      reason: "The destination has no room matching “Grand Hall”.",
      applied: [],
      incompatible: [],
    },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** Every template route, with the two mutating ones recorded rather than assumed. */
function stubTemplates(
  application: unknown = { ...partial, outcome: "applied" },
  listed: EventTemplateDto = template,
  held: readonly EventTemplateVersionDto[] = [version],
  applications: readonly unknown[] = [],
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/template-application-previews")) return jsonResponse({ plan });
    // GET and POST share this URL: one reads what has already been applied to the event, the
    // other applies. Answering the read with the write's body would decode as a schema failure.
    if (url.endsWith("/template-applications"))
      return _init?.method === "POST"
        ? jsonResponse({ application })
        : jsonResponse({ applications });
    if (url.endsWith(`/event-templates/${templateId}`))
      return jsonResponse({ template: listed, versions: held });
    return jsonResponse({ templates: [listed] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderWorkspace = () =>
  render(
    <EventTemplatesWorkspace
      organizationId={organizationId}
      eventId={eventId}
      eventName="Greenroom Summit"
      canApply
      canAuthor
    />,
  );

/** Calls that *wrote*. The applications URL is also read on load, and a read carries no body. */
const postsTo = (fetchMock: ReturnType<typeof stubTemplates>, suffix: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => String(input).endsWith(suffix) && init?.method === "POST",
  );

const bodyOf = (fetchMock: ReturnType<typeof stubTemplates>, suffix: string) =>
  JSON.parse(String(postsTo(fetchMock, suffix)[0]?.[1]?.body ?? "null"));

/** Open the seeded template, confirm a destination range, and take a preview. */
async function previewTheClone(startsOn = "2027-03-08", endsOn = "2027-03-10") {
  fireEvent.click(await screen.findByRole("button", { name: "Annual summit starter" }));
  fireEvent.change(screen.getByLabelText("First day"), { target: { value: startsOn } });
  fireEvent.change(screen.getByLabelText("Last day"), { target: { value: endsOn } });
  fireEvent.click(screen.getByRole("button", { name: "Preview this clone" }));
  return within(await screen.findByRole("region", { name: "Preview" }));
}

describe("event templates", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the organization's templates with their state and version count", async () => {
    stubTemplates();
    renderWorkspace();

    const row = (await screen.findByRole("button", { name: "Annual summit starter" })).closest(
      "li",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Active");
    expect(row?.textContent).toContain("1 version");
    expect(row?.textContent).toContain("newest captured from Greenroom Demo Summit");
  });

  it("counts what it holds in English, at both ends of the plural", async () => {
    const second = {
      ...version,
      id: "523e4567-e89b-42d3-a456-426614174004",
      version: 2,
      slices: ["cfp", "agenda"],
    };
    stubTemplates(undefined, template, [second, version]);
    renderWorkspace();

    const opener = await screen.findByRole("button", { name: "Annual summit starter" });
    expect(opener.closest("li")?.textContent).toContain("2 versions");
    fireEvent.click(opener);

    // The pill is where a naive plural showed: a version carrying two categories said "categorys".
    const versions = within(screen.getByRole("region", { name: "Annual summit starter" }));
    expect(versions.getByText("2 categories")).toBeInTheDocument();
    expect(versions.getByText("1 category")).toBeInTheDocument();
  });

  it("refuses the preview of an archived template it has already called unappliable", async () => {
    const fetchMock = stubTemplates(undefined, { ...template, state: "archived" });
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "Annual summit starter" }));

    // The range is confirmed first, so the only thing left holding the control shut is the state.
    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2027-03-08" } });
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2027-03-10" } });

    const apply = within(screen.getByRole("region", { name: "Apply to Greenroom Summit" }));
    const previewButton = apply.getByRole("button", { name: "Preview this clone" });
    expect(previewButton).toBeDisabled();
    expect(apply.getByText(/archived template cannot be applied/)).toBeInTheDocument();

    // The server refuses the apply and not the preview, so a live control here would spend a
    // full per-category breakdown on a clone this event was never going to be given.
    fireEvent.click(previewButton);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/template-application-previews"),
      ),
    ).toBe(false);
  });

  it("breaks a preview down by category and writes nothing", async () => {
    const fetchMock = stubTemplates();
    renderWorkspace();
    const preview = await previewTheClone();

    // Copied, excluded and refused are three different answers and are reported as three.
    expect(preview.getByText("Field: Proposal title")).toBeInTheDocument();
    expect(preview.getByText("Submitted proposals and their answers")).toBeInTheDocument();
    expect(preview.getByText("Routing rule to “shortlisted”")).toBeInTheDocument();
    // A category this system copies nothing for is listed with its reason, not omitted.
    expect(preview.getByText(/Already shared at the organization/)).toBeInTheDocument();

    expect(bodyOf(fetchMock, "/template-application-previews")).toEqual({
      templateId,
      version: 1,
      destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
    });
    // The claim in the copy, asserted on the wire: nothing has been applied.
    expect(postsTo(fetchMock, "/template-applications")).toHaveLength(0);
  });

  it("applies the command the preview resolved, not the controls' later values", async () => {
    const fetchMock = stubTemplates();
    renderWorkspace();
    await previewTheClone();

    // The date boxes stay live while the breakdown is on screen. An organizer who nudges one
    // after reading the plan must not silently commit a clone nobody previewed.
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2027-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply version 1 to Greenroom Summit" }));

    await waitFor(() =>
      expect(postsTo(fetchMock, "/template-applications").length).toBeGreaterThan(0),
    );
    expect(bodyOf(fetchMock, "/template-applications")).toEqual({
      templateId,
      version: 1,
      destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
    });
  });

  it("names every category's outcome and refuses to soften the partial guarantee", async () => {
    stubTemplates(partial);
    renderWorkspace();
    await previewTheClone();
    fireEvent.click(screen.getByRole("button", { name: "Apply version 1 to Greenroom Summit" }));

    const panel = await screen.findByRole("region", { name: "Applied in part" });
    const result = within(panel);
    const cfp = result.getByText("CFP form and routing").closest("li");
    const agenda = result.getByText("Rooms and time slots").closest("li");
    expect(cfp?.textContent).toContain("Applied");
    expect(agenda?.textContent).toContain("Failed");
    expect(agenda?.textContent).toContain("no room matching");
    // ARC-FLOW-006 is a documented guarantee, so the surface states it rather than hedging.
    // Read from the panel's text because the sentence emphasises one word inside itself.
    expect(panel.textContent).toContain("does not roll back the categories that succeeded");
    expect(panel.textContent).toContain("Applying this same version again is the repair");
  });

  /*
   * Issue #175. Everything below is about the state *after* the response that reported it: an
   * organizer who was never here when the clone ran, opening the workspace cold.
   */
  describe("an application that landed in part", () => {
    /** As storage holds it: the envelope word, the range, and the categories, read back. */
    const storedPartial = {
      templateId,
      templateName: template.name,
      templateState: "active" as const,
      templateVersionId: versionId,
      version: 1,
      appliedAt: "2027-01-05T12:00:00.000Z",
      appliedBy: "seed-organizer",
      appliedByName: "Olivia Organizer",
      outcome: "partial" as const,
      destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
      slices: partial.slices,
    };

    it("says so on a page nobody applied anything on, and names what is missing", async () => {
      stubTemplates(undefined, template, [version], [storedPartial]);
      renderWorkspace();

      const card = within(
        await screen.findByRole("region", { name: "Greenroom Summit is configured in part" }),
      );
      // The category that did not land, with the destination's own reason for refusing it.
      expect(card.getByText("Rooms and time slots")).toBeInTheDocument();
      expect(card.getByText(/no room matching/)).toBeInTheDocument();
      // And not the one that did: this card is what is still outstanding, not a full history.
      expect(card.queryByText("CFP form and routing")).toBeNull();
      // Named rather than an account id, and dated, because "who and when" is the first thing
      // an organizer inheriting a half-configured event asks.
      expect(card.getByText(/by Olivia Organizer/)).toBeInTheDocument();
    });

    it("repairs it with the stored command rather than whatever the controls hold", async () => {
      const selected = { ...storedPartial, selection: ["cfp", "agenda"] };
      const fetchMock = stubTemplates(partial, template, [version], [selected]);
      renderWorkspace();

      fireEvent.click(
        await screen.findByRole("button", { name: "Re-apply version 1 to Greenroom Summit" }),
      );

      await waitFor(() =>
        expect(postsTo(fetchMock, "/template-applications").length).toBeGreaterThan(0),
      );
      /*
       * The version, the range and the category selection all come from the stored row. The
       * page's own date boxes were never filled in, so a repair built from the controls would
       * have sent an empty range — and a repair built from "everything the version carries"
       * would have applied two categories the original command deliberately left out.
       */
      expect(bodyOf(fetchMock, "/template-applications")).toEqual({
        templateId,
        version: 1,
        destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
        slices: ["cfp", "agenda"],
      });
    });

    it("clears once the repair lands, because the surface re-reads what is stored", async () => {
      // The second attempt writes the category the first one could not, so both the stored row
      // and the response the click gets back say every category landed.
      const landed = partial.slices.map((slice) => ({ ...slice, outcome: "applied" as const }));
      const repaired = { ...storedPartial, outcome: "applied" as const, slices: landed };
      let read = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/template-applications") && init?.method === "POST")
          return jsonResponse({ application: { ...partial, outcome: "applied", slices: landed } });
        // The second read is the one taken after the repair, and the server's answer has moved.
        if (url.endsWith("/template-applications"))
          return jsonResponse({ applications: [read++ === 0 ? storedPartial : repaired] });
        if (url.endsWith(`/event-templates/${templateId}`))
          return jsonResponse({ template, versions: [version] });
        return jsonResponse({ templates: [template] });
      });
      vi.stubGlobal("fetch", fetchMock);
      renderWorkspace();

      fireEvent.click(
        await screen.findByRole("button", { name: "Re-apply version 1 to Greenroom Summit" }),
      );

      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Greenroom Summit is configured in part" }),
        ).toBeNull(),
      );
      expect(await screen.findByText(/re-applied in full/)).toBeInTheDocument();
    });

    it("will not offer a repair the server would refuse", async () => {
      stubTemplates(
        undefined,
        template,
        [version],
        [{ ...storedPartial, templateState: "archived" as const }],
      );
      renderWorkspace();

      const card = within(
        await screen.findByRole("region", { name: "Greenroom Summit is configured in part" }),
      );
      expect(
        card.getByRole("button", { name: "Re-apply version 1 to Greenroom Summit" }),
      ).toBeDisabled();
      expect(card.getByText(/archived template cannot be applied/)).toBeInTheDocument();
    });

    it("stays quiet about an application that landed whole", async () => {
      stubTemplates(
        undefined,
        template,
        [version],
        [{ ...storedPartial, outcome: "applied" as const }],
      );
      renderWorkspace();

      await screen.findByRole("button", { name: "Annual summit starter" });
      expect(
        screen.queryByRole("region", { name: "Greenroom Summit is configured in part" }),
      ).toBeNull();
    });
  });
});
