// @acceptance ACC-IDENTITY-EVENTS
/*
 * The developer surface, and the things about it that can silently stop being true.
 *
 * The first is arithmetic. `/developers` prints how many operations the contract has, and that
 * figure is a literal in the component because deriving it would mean shipping a 3.5 MB OpenAPI
 * document to every reader of a marketing page. A literal is only allowed to stand if something
 * fails when it drifts, which is what the first test here is: it reads the real generated
 * document and counts. A route added without touching this page turns the page into a page that
 * overstates the product, and overstating is the one failure the landing surfaces exist not to
 * do.
 *
 * The rest are the same shape: the capability count, and the error code the failure sample
 * prints, each held to the schema that actually defines it.
 *
 * The last is the hand-off. Every other signed-out surface is replaced by the console the
 * instant the identity probe reports a session, because every other one is the anonymous version
 * of something the console owns. This one is a public reference, so a signed-in reader has to be
 * able to read it — and that is a branch in `LandingRoot`, which means it can be undone by any
 * later edit to the probe effect.
 */
import { apiErrorCodeSchema, capabilitySchema } from "@greenroom/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LandingBootstrap } from "../src/api/identity";
import { CONTRACT, ERROR_SAMPLE_CODE } from "../src/landing/ApiPage";
import { LandingRoot } from "../src/landing/LandingPage";
import openApiDocument from "../../../packages/contracts/openapi.json";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type OpenApiDocument = {
  openapi: string;
  info: { version: string };
  paths: Record<string, Partial<Record<(typeof METHODS)[number], unknown>>>;
};

/* Not `document`: this file renders into jsdom, and shadowing that global here is the kind
   of name that reads correctly and means something else. */
const contract = openApiDocument as OpenApiDocument;

/** A deployment that answers the probe and offers nothing, which is all this surface needs. */
const signedOut: LandingBootstrap = { session: null, doors: null, failure: null };

/** The seeded persona a demo deployment resolves, reduced to the fields the shell reads. */
const signedIn: LandingBootstrap = {
  session: {
    actor: { id: "actor-1", name: "Olivia Organizer", persona: "organizer" },
    organizations: [],
    eventAccess: [],
    capabilities: [],
    authentication: "demo",
  },
  doors: { demoMode: true, google: false },
  failure: null,
};

describe("the figures the developer surface prints", () => {
  it("counts what the generated document actually contains", () => {
    const operations = Object.values(contract.paths).flatMap((item) =>
      METHODS.filter((method) => item[method] !== undefined),
    );
    /*
     * Split rather than totalled, because the page describes them as two different offers: what a
     * browser may read from the published projection, and what somebody with no account is allowed
     * to send. A new public POST landing silently inside a figure that says "reads" would be the
     * least visible way this page could start overstating what is open.
     */
    const publicOperations = Object.entries(contract.paths).flatMap(([path, item]) =>
      path.startsWith("/api/public/") ? METHODS.filter((method) => item[method] !== undefined) : [],
    );
    expect(CONTRACT.operations).toBe(operations.length);
    expect(CONTRACT.paths).toBe(Object.keys(contract.paths).length);
    expect(CONTRACT.publicReads).toBe(publicOperations.filter((method) => method === "get").length);
    expect(CONTRACT.publicWrites).toBe(
      publicOperations.filter((method) => method !== "get").length,
    );
    expect(CONTRACT.openapi).toBe(contract.openapi);
    expect(CONTRACT.version).toBe(contract.info.version);
  });

  /*
   * The other figure on the page, and the one with real consequences if it drifts: a credential's
   * scope list is a security surface, and "a subset of the 13 capabilities" is a claim about how
   * much a caller can be handed. A capability added to the enum without touching this page makes
   * that sentence understate the blast radius of a credential.
   */
  it("counts the capabilities a credential can be granted", () => {
    expect(CONTRACT.capabilities).toBe(capabilitySchema.options.length);
  });

  /*
   * The sample failure body prints a code, and a documented code the API cannot return is the one
   * mistake on this page a reader only finds by writing the handler for it. The first draft
   * printed `TIMEZONE_REJECTED`, which the compatibility policy names as a *field error* rather
   * than as a code.
   */
  it("prints a failure code the contract actually declares", () => {
    expect(apiErrorCodeSchema.options).toContain(ERROR_SAMPLE_CODE);
  });
});

describe("the developer surface", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/developers");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("hands the reader to the generated reference rather than restating it", async () => {
    render(<LandingRoot bootstrap={Promise.resolve(signedOut)} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Greenroom is an API with a console on top of it.",
      }),
    ).toBeInTheDocument();
    // Both discovery routes, by their real paths. They are served by the Worker rather than by
    // this bundle, so a client-side link to either would be a page that never loads.
    for (const reference of screen.getAllByRole("link", { name: "Browse the API reference" }))
      expect(reference).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "Download the OpenAPI document" })).toHaveAttribute(
      "href",
      "/openapi.json",
    );
    expect(
      screen.getByRole("heading", { name: "Three ways a request is authenticated" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Events pushed to you, signed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What may change under you" })).toBeInTheDocument();
  });

  /*
   * The claim this repository would be easiest to overstate.
   *
   * A machine credential is issued, stored and displayed by a demo deployment and never accepted
   * by one, because `transport/http/app.ts` takes the persona branch before it reaches the bearer
   * grammar. A developer page that described the credential and omitted that would be sending
   * readers to find it out from a 401.
   */
  it("says on the credential's own row that a demo deployment will not accept one", async () => {
    render(<LandingRoot bootstrap={Promise.resolve(signedOut)} />);

    await screen.findByRole("heading", { name: "Three ways a request is authenticated" });
    expect(
      screen.getByText(/Bearer credentials are resolved on a deployment that is not in demo mode/),
    ).toBeInTheDocument();
    // And the public half is bounded by publication rather than by permission, which is the other
    // sentence a reader would otherwise learn from a surprise.
    expect(
      screen.getByText(/An unpublished event answers these routes exactly as an unknown slug does/),
    ).toBeInTheDocument();
  });

  /**
   * A reference nobody has to sign out to read.
   *
   * Every other landing surface is replaced by the console when the probe reports a session. If
   * this one were, an organizer following the footer link from their own product would land on
   * their Overview and never see the page.
   */
  it("stays on screen for a reader who is already signed in", async () => {
    render(<LandingRoot bootstrap={Promise.resolve(signedIn)} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Greenroom is an API with a console on top of it.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Overview" })).toBeNull();
  });
});

describe("finding the API from the home page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /*
   * The defect this whole surface was added for: the API was undiscoverable from the one page a
   * visitor is guaranteed to see. Three routes to it now — the bar, the section, and the footer —
   * and each is asserted by the name a reader would look for rather than by a selector.
   */
  it("offers the API from the bar, the argument, and the footer", async () => {
    render(<LandingRoot bootstrap={Promise.resolve(signedOut)} />);

    await screen.findByRole("heading", { level: 1, name: /Run the whole conference/ });
    // The bar is a navigation landmark now that it has two destinations in it, and it is named:
    // an unnamed `nav` is one a screen-reader user has to enter to identify.
    const bar = screen.getByRole("navigation", { name: "Greenroom" });
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API Docs" })).toHaveAttribute("href", "/developers");
    expect(screen.getByRole("heading", { name: "All of it over HTTP, too." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How the API works" })).toHaveAttribute(
      "href",
      "/developers",
    );
    expect(screen.getByRole("link", { name: "The HTTP API and its reference" })).toHaveAttribute(
      "href",
      "/developers",
    );
    // The claim in the section is the same figure the reference page prints, from one constant.
    expect(
      screen.getByText(new RegExp(`${CONTRACT.operations} documented operations`)),
    ).toBeInTheDocument();
  });
});
