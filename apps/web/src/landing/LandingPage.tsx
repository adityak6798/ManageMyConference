/*
 * The three surfaces a visitor sees before they are anybody: "/", "/signin", and the invitation
 * link they were sent.
 *
 * "/" is also the console's home once a session exists, and the session cookie is `httpOnly`,
 * so the document cannot tell which of the two it is by itself. `LandingRoot` is the answer:
 * it renders while the probe in `api/identity.ts` is in flight, shows the marketing page or
 * the sign-in page when the API says nobody is signed in, and dynamically imports the console
 * and hands the document over when it says somebody is. The console is not in this bundle —
 * an anonymous visitor downloading an organizer's workspace to read a headline is exactly the
 * mistake `main.tsx` documents for the public event pages.
 *
 * The copy here claims only what the repository can defend, and the capability ledger is the
 * page's argument rather than an appendix to it: two of the nine capabilities are marked as
 * built-but-unproven on purpose, and the wording of those two is derived from
 * docs/product/competition-traceability.md rather than from optimism. An evaluator who finds an
 * overstatement here has been given a reason to disbelieve the other seven, so the two that are
 * unproven are on the same list, in the same shape, as the seven that ship.
 */

import type { SessionDto } from "@greenroom/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type AuthDoors, describeIdentityFailure, type LandingBootstrap } from "../api/identity";
import { navigate, useLinkProps, useLocation } from "../router";
import { ApiSurface, CONTRACT } from "./ApiPage";
import { SignInPanel, useDemoDoor } from "./SignInPanel";
import "./landing.css";

type ConsoleModule = typeof import("../App");

/** The console, once it has arrived, with everything the probe already learned for it. */
type Workspace = {
  App: ConsoleModule["App"];
  session: SessionDto | null;
  realSession: boolean;
};

/**
 * Which signed-out surface this is. The invitation link is one of them, not a stray URL.
 *
 * `api` is the odd one, and deliberately: it is the only one that is *not* a question about
 * identity. It is a public reference, so it renders for a signed-in reader too rather than being
 * replaced by the console the way "/" is.
 */
type Surface = "home" | "signin" | "invitation" | "api";

const SOURCE_URL = "https://github.com/adityak6798/ManageMyConference";

/**
 * Where an invitation link lands, mirrored from `App.tsx`.
 *
 * It is a literal in both files rather than an import: the console is the module this page
 * exists to *not* download, and reaching into it for a six-character string would undo that.
 */
const ACCEPT_INVITATION_PATH = "/invitations/accept";

/**
 * Where the developer reference lives, and why it is not `/api` or `/docs`.
 *
 * Both of those are already taken by the deployment itself: `wrangler.toml` runs the Worker
 * first for `/api/*`, `/health`, `/openapi.json` and `/docs`, so a route claimed here under
 * either name would be a page nobody could reach — the Worker would answer first and this
 * bundle would never be asked. `/developers` is the surface; `/docs` remains the generated
 * operation browser it links to.
 */
const DEVELOPERS_PATH = "/developers";

/**
 * Where the invitation token waits while its invitee signs in.
 *
 * Accepting needs both halves — the token names the invitation, this browser's session names
 * the person — and a signed-out invitee has only the first. Every door out of this page is a
 * full navigation: the Google flow leaves for a consent screen and its callback lands on a path
 * the *server* chooses, because that route refuses to take a destination from the request (the
 * open redirect it would otherwise be). Nothing in the URL survives that, so the token is held
 * in `sessionStorage`, which is scoped to this tab and dies with it.
 */
const INVITATION_STASH_KEY = "greenroom.invitation-token";

function stashInvitationToken(token: string) {
  try {
    window.sessionStorage.setItem(INVITATION_STASH_KEY, token);
  } catch {
    // ERROR-INTENT: storage can be disabled or full, and a token that cannot be stashed costs
    // this visitor only the automatic hand-off — the accept surface still reads the token from
    // the link they followed, so there is nothing here for a refusal to recover.
    return;
  }
}

/** The stashed token, taken rather than read: it is spent by the navigation it causes. */
function takeInvitationToken(): string | null {
  try {
    const token = window.sessionStorage.getItem(INVITATION_STASH_KEY);
    window.sessionStorage.removeItem(INVITATION_STASH_KEY);
    return token;
  } catch {
    // ERROR-INTENT: same as stashing — with no stash there is no hand-off, and the accept
    // surface still works from the link itself.
    return null;
  }
}

type CapabilityState = "ships" | "built";

const productProof: readonly {
  title: string;
  body: string;
  state: CapabilityState;
  qualifier?: string;
}[] = [
  {
    title: "Proposal forms that branch",
    body: "Ask a workshop pitch different questions from a lightning talk, and send each answer to the triage queue that should see it. Conditions and routes travel with the published form, and the route a submission resolved to is written down beside it.",
    state: "ships",
  },
  {
    title: "A portal speakers actually finish",
    body: "Bios, headshots and slides, uploaded by the speaker against a task list that says what is still outstanding. An organizer publishes a headshot to the public gallery, or takes it back, and the gallery falls back to initials rather than to a broken image.",
    state: "ships",
  },
  {
    title: "Speaker mail and calendar invitations",
    body: "Immutable templates and a durable outbox with retry, recovery and terminal failure, enqueued by the lifecycle itself: acceptance, task and reviewer assignment, a decision, a published schedule. Invitations are real iTIP requests carrying organizer, attendee and a strictly rising sequence, plus Google, Outlook and .ics routes.",
    state: "built",
    qualifier:
      "The invitation is built correctly and reaches the provider. This deployment's provider sends no mail, so no mail client has yet rendered one.",
  },
  {
    title: "Blind review with a locked rubric",
    body: "Blind queues, a rubric that cannot move underneath a reviewer, drafts, declared conflicts, multiple rounds that keep the earlier round intact, and the organizer aggregates over all of it. AI-assisted suggestions are optional and can only ever write a draft a reviewer still has to complete.",
    state: "ships",
    qualifier:
      "The default suggestion provider is deterministic and needs no credential; no live model API has been called from this build.",
  },
  {
    title: "A schedule you can drag",
    body: "A room-by-time board with pointer drag and every one of the same moves on the keyboard. Conflicts are explained before they can be published, and the list, day, week, track and room views live in the URL, so the link you paste opens the view you were looking at.",
    state: "ships",
  },
  {
    title: "A dashboard that names names",
    body: "Not “nine tasks outstanding”. Which speaker, which task, what it was due, how many days late — counted in the event's own timezone and refreshed while you watch, with each panel degrading on its own rather than blanking the page.",
    state: "ships",
  },
  {
    title: "Registration import from Accelevents",
    body: "Registrations come across one way and become speaker profiles: a dry run that writes nothing, an apply that converges instead of duplicating, provenance per record and failures per row, with the surface naming which source answered.",
    state: "built",
    qualifier:
      "It runs today against a deterministic roster. It has not yet exchanged a request with the live Accelevents API.",
  },
  {
    title: "Resource pages, safely embedded",
    body: "Author reference material for speakers, order it, hide it. Embedded HTML is sanitized by a real parser rather than a regular expression, and reference frames are restricted to allowlisted HTTPS hosts with scripts off.",
    state: "ships",
  },
  {
    title: "A public site, and embeds of it",
    body: "A versioned multi-day programme at its own address, as JSON, and as copy-paste schedule, session, speaker, gallery, and itinerary embeds. One active projection is behind all of them, so a schedule publish moves every public surface together.",
    state: "ships",
  },
];

const provenCount = productProof.filter(({ state }) => state === "ships").length;
const unprovenCount = productProof.length - provenCount;

/**
 * The four captures, each with the claim it is evidence for.
 *
 * `alt` carries that claim, because a reader who cannot see the picture is exactly the reader
 * the claim is for; the caption names the surface and the route it was taken at, so a reader
 * who *can* see it knows where in the product they are looking. The captions used to be the
 * file name with its first letter raised, which produced "Forms" — a word this product does not
 * use for anything.
 *
 * Each `alt` describes what its capture can be checked to contain. Every one of them used to
 * describe a picture that was never taken: speaker tasks "late" when the capture shows them due
 * in four days, conditional questions and triage routes on a form the fixture routes nowhere,
 * conflicts "listed above" a board whose conflict count is zero. Alt text that overstates the
 * picture is the one kind that cannot be caught by looking at the page.
 */
const captures = [
  {
    name: "overview",
    label: "Organizer overview",
    route: "/",
    alt: "The organizer overview, opening on the two proposals awaiting a decision as the work to pick up next, above counts of proposals received, decisions outstanding, accepted sessions, sessions placed on the board and speakers, then every open speaker task with its deadline and the proposals still undecided.",
  },
  {
    name: "submissions",
    label: "Submissions queue",
    route: "/program?tab=submissions",
    alt: "The submissions queue, four proposals under status tabs that count them, each row carrying its status, the reviewers assigned to it in each round, the score its completed reviews produced, and the control that records a decision.",
  },
  {
    name: "agenda",
    label: "Agenda board",
    route: "/schedule?tab=agenda",
    alt: "The agenda board in its week view, both accepted sessions placed at a time on the day they run with the room named on each card, beside the panel that unschedules a session by dragging it off the grid, and above a conflict count of zero on a schedule not yet published.",
  },
  {
    name: "public-event",
    label: "Public event page",
    route: "/events/:slug",
    alt: "The published event page an attendee sees: the dates, venue and summary of the event, how each of its two days opens with the session, room and track that starts it, and the speaker cards below, all served from one versioned projection.",
  },
] as const;

const pillars = [
  [
    "One operational record",
    "Proposals, decisions, speakers, sessions, and the public programme move through one deliberate lifecycle.",
  ],
  [
    "Clear work for every role",
    "Organizers see operations; reviewers see their queue; speakers see what they owe; attendees see only what is published.",
  ],
  [
    "Publishing you can trust",
    "A single versioned projection powers the event site, schedule, detail pages, itinerary, embeds, and JSON feed.",
  ],
  [
    "Open by default",
    "Run it yourself, inspect the source, and verify the limits. Greenroom does not hide critical event data behind a proprietary export.",
  ],
] as const;

/*
 * The one place on this page where a number is a measure rather than an ornament.
 *
 * These six steps happen in this order — you cannot review a proposal you have not collected —
 * so the step number is the figure each row is about, and the rows get the product's cue gutter:
 * a fixed monospace measure column behind a spine that does not break between them. The nine
 * capabilities below have no such order, which is why their 01–09 ornament is gone.
 */
const lifecycle = [
  ["01", "Shape the call", "Publish conditional proposal questions and a real submission window."],
  [
    "02",
    "Collect proposals",
    "Keep guest submissions, account drafts, revisions, and participants intact.",
  ],
  [
    "03",
    "Review fairly",
    "Route blind assignments through a locked rubric with conflicts and drafts.",
  ],
  [
    "04",
    "Prepare speakers",
    "Turn acceptances into profiles, tasks, private uploads, and calendar actions.",
  ],
  [
    "05",
    "Build the programme",
    "Place sessions, resolve conflicts, and publish the agenda deliberately.",
  ],
  [
    "06",
    "Welcome attendees",
    "Serve one public programme across pages, itineraries, embeds, and JSON.",
  ],
] as const;

/** The sticky bar, shared by the boot state and by every surface underneath it. */
/*
 * A `<header>`, because this is the page's banner and a landmark is what a reader navigates by.
 *
 * It was a plain `<div>`, so the marketing page and the sign-in page shipped a `contentinfo`
 * landmark and no `banner` — the brandmark and the one door out of the surface were reachable
 * only by tabbing past them. `.landing-topbar` is unchanged; only the element is.
 */
function LandingTopBar({ active }: { active: Surface }) {
  const linkProps = useLinkProps();
  return (
    <header className="landing-topbar">
      <div className="landing-topbar-inner">
        <a className="landing-brand" {...linkProps("/")}>
          <span className="landing-glyph" aria-hidden="true">
            G
          </span>
          Greenroom
        </a>
        {/* Two destinations now, so they are a navigation landmark rather than a stray link. It
            is named, because an unnamed `nav` is one a screen-reader user has to enter to
            identify — and "Greenroom" is what this one navigates. */}
        <nav className="landing-topbar-nav" aria-label="Greenroom">
          {/* A capsule, which is the shape this product reserves for two words — the ledger's
              state marker deliberately is not one because "Built, not yet proven end to end" is a
              sentence. "API Docs" is two, and the pill is what makes it read as a destination
              worth a look rather than as a third piece of bar furniture. */}
          <a
            className="landing-topbar-link"
            {...linkProps(DEVELOPERS_PATH)}
            // Here the aria-current *is* true, which is why it is set here and not below.
            {...(active === "api" ? { "aria-current": "page" as const } : {})}
          >
            API Docs
          </a>
          <a
            className="landing-door secondary is-sm"
            /*
             * A real navigation off the reference, not a pushState.
             *
             * "/" is the marketing page for a visitor and the console's home for an organizer, and
             * `main.tsx` is the module that decides which. Leaving the reference client-side asked
             * `LandingRoot` to make that call instead, and Back then landed on a `/developers` the
             * console does not route: it painted "That workspace does not exist" and replaced the
             * URL, so Back was a no-op *and* the history entry was destroyed. Every other surface
             * here is one the landing chunk can render either way, so only this one pays the
             * round trip.
             */
            {...(active === "api" ? { href: "/" } : linkProps(active === "home" ? "/signin" : "/"))}
            // No `aria-current`: away from home this link points *back*, at "/", and marking it as
            // the current page tells a screen reader that "Back to the overview" is where you are.
            // axe has no rule for a truthful-but-misapplied aria-current, so the quality gate would
            // never have caught it.
          >
            {active === "home" ? "Sign in" : "Back to the overview"}
          </a>
        </nav>
      </div>
    </header>
  );
}

/**
 * Shared chrome, rendered once and kept across the move between surfaces.
 *
 * Mounted once on purpose: a client-side navigation moves nothing for a screen reader by
 * itself, so `main` takes focus when the surface changes — and it can only notice a change if
 * the same element is still there to compare against. Remounting the chrome per surface would
 * reset that memory and the focus move would never happen.
 */
function LandingChrome({
  children,
  active,
  doors,
}: {
  children: ReactNode;
  active: Surface;
  doors: AuthDoors | null;
}) {
  const linkProps = useLinkProps();
  const mainRef = useRef<HTMLElement>(null);
  const landedOn = useRef(active);

  useEffect(() => {
    if (landedOn.current === active) return;
    landedOn.current = active;
    mainRef.current?.focus();
  }, [active]);

  return (
    <div className="landing-shell">
      <a className="landing-skip" href="#landing-main">
        Skip to main content
      </a>
      <LandingTopBar active={active} />
      {/* tabIndex={-1} is a focus target for the skip link and for navigation, not a tab stop. */}
      <main id="landing-main" ref={mainRef} tabIndex={-1}>
        {children}
      </main>
      <footer>
        <p className="landing-footer-brand">
          Project Greenroom — a conference operations workspace.
        </p>
        {/* The repository used to be reachable from one link in the middle of the page, and the
            page ended on prose. A footer is where a reader looks for the way out. */}
        <ul className="landing-footer-links">
          <li>
            <a href={SOURCE_URL}>Source on GitHub</a>
          </li>
          <li>
            {/* Not "API Docs", which is the bar's own name for this destination. A footer that
                repeats a name already on screen is the same coin toss the sign-in link avoids. */}
            <a {...linkProps(DEVELOPERS_PATH)}>The HTTP API and its reference</a>
          </li>
          <li>
            {/* Not "Sign in": the sticky bar already has a link by that exact name, and two
                links with one name is a coin toss for anybody driving this page by voice. */}
            <a {...linkProps("/signin")}>Sign in to Greenroom</a>
          </li>
          {doors?.demoMode ? (
            <li>
              <a href="/events/greenroom-demo-summit">The demo event, published</a>
            </li>
          ) : null}
        </ul>
        <p className="landing-footer-note">
          Built in the open. Greenroom claims only what this repository can demonstrate; where a
          capability has not yet met a live third party, it says so on its own row rather than being
          counted among the rest.
        </p>
      </footer>
    </div>
  );
}

/**
 * The doors, in the hero and again at the close.
 *
 * On a seeded deployment the primary *starts the demo* rather than linking to a page that shows
 * a strict subset of what is already on screen. It deliberately does not share its name with the
 * four persona buttons in the panel — twenty-one browser specs find those by the exact string
 * "Continue as organizer", and two controls answering to one name is a coin toss for anybody
 * driving this page by voice or by keyboard.
 *
 * Each instance owns its own demo door so that a failure is reported beside the button that was
 * pressed, rather than at the other end of the page from it.
 */
function LandingDoors({
  doors,
  onSignedIn,
  withAlternate,
}: {
  doors: AuthDoors | null;
  onSignedIn: (realSession: boolean) => void;
  /** Offer the other three personas beside the primary. Only the hero, which sits by the panel. */
  withAlternate: boolean;
}) {
  const linkProps = useLinkProps();
  const door = useDemoDoor(onSignedIn);

  if (!doors?.demoMode)
    return (
      <div className="landing-doors">
        <a className="landing-door" {...linkProps("/signin")}>
          Get started
        </a>
        {withAlternate ? (
          <a className="landing-door secondary" href="#capabilities">
            See all nine capabilities
          </a>
        ) : null}
      </div>
    );

  return (
    <>
      <div className="landing-doors">
        <button
          type="button"
          className="landing-door"
          disabled={door.busy}
          onClick={() => door.start("organizer")}
        >
          Open the demo as an organizer
        </button>
        {withAlternate ? (
          <a className="landing-door secondary" href="#signin-panel">
            Choose another role
          </a>
        ) : null}
      </div>
      {door.error ? (
        <p className="landing-notice error" role="alert">
          {door.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * The ledger: every capability this repository claims, and the state each one is actually in.
 *
 * It used to sit behind a `<details>` at the bottom of the page, which put the one thing a
 * competitor's site will not have — two rows that say "not yet proven" — behind a disclosure
 * triangle nobody opens.
 */
function CapabilityLedger() {
  return (
    <ul className="landing-ledger">
      {productProof.map((capability) => (
        <li key={capability.title}>
          <div className="landing-ledger-head">
            <h3>{capability.title}</h3>
            <p
              className={
                capability.state === "ships"
                  ? "landing-ledger-state figure"
                  : "landing-ledger-state figure is-built"
              }
            >
              {capability.state === "ships" ? "Ships today" : "Built, not yet proven end to end"}
            </p>
          </div>
          <div className="landing-ledger-body">
            <p>{capability.body}</p>
            {capability.qualifier ? (
              <p className="landing-ledger-note">{capability.qualifier}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function LandingSurface({
  doors,
  notice,
  onSignedIn,
}: {
  doors: AuthDoors | null;
  notice?: ReactNode;
  onSignedIn: (realSession: boolean) => void;
}) {
  const linkProps = useLinkProps();
  return (
    <>
      <div className="landing-hero">
        <div className="landing-hero-copy">
          <h1>Run the whole conference without losing the thread.</h1>
          <p className="landing-lede">
            Greenroom connects the call for proposals, blind review, speaker readiness, scheduling,
            and the public programme in one open-source workspace.
          </p>
          <LandingDoors doors={doors} onSignedIn={onSignedIn} withAlternate />
          {doors?.demoMode ? (
            <p className="landing-fineprint">
              The demo needs no account and no credit card. It opens on a seeded conference with
              proposals mid-review and a schedule half built, because an empty product proves
              nothing.
            </p>
          ) : null}
        </div>
        <SignInPanel
          doors={doors}
          variant="landing"
          onSignedIn={onSignedIn}
          {...(notice ? { notice } : {})}
        />
      </div>

      <section className="landing-section" id="capabilities" aria-labelledby="capabilities-title">
        <div className="landing-section-head">
          <h2 id="capabilities-title">
            {productProof.length} capabilities. {provenCount} proven end to end, {unprovenCount}{" "}
            not.
          </h2>
          <p>
            The whole list, with the two that have not yet met a live third party marked as exactly
            that. Core conference workflows run end to end in the seeded product; live email
            rendering and live Accelevents exchange are deployment-dependent, and Greenroom labels
            them rather than presenting a deterministic adapter as third-party proof.
          </p>
        </div>
        <CapabilityLedger />
      </section>

      <section className="landing-section" aria-labelledby="captures-title">
        <div className="landing-section-head">
          <h2 id="captures-title">A real conference, already in motion</h2>
          <p>
            The demo fixture contains routed proposals, review work, speaker tasks, a placed agenda,
            and a published event. These are generated captures of that same deterministic product.
          </p>
        </div>
        <div className="landing-captures">
          {captures.map((capture) => (
            <figure key={capture.name}>
              <img
                src={`/product-captures/${capture.name}.webp`}
                alt={capture.alt}
                width="1440"
                height="900"
                loading="lazy"
                decoding="async"
              />
              <figcaption>
                <span className="landing-capture-label">{capture.label}</span>
                <span className="figure landing-capture-route">{capture.route}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-labelledby="lifecycle-title">
        <div className="landing-section-head">
          <h2 id="lifecycle-title">Six steps. One continuous record.</h2>
        </div>
        <ol className="landing-lifecycle">
          {lifecycle.map(([number, title, body]) => (
            <li key={number}>
              <span className="landing-cue">
                <span className="figure">
                  <span className="landing-hidden">Step </span>
                  {number}
                </span>
              </span>
              <div className="landing-cue-body">
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="pillars-title">
        <div className="landing-section-head">
          <h2 id="pillars-title">Four principles, not a pile of features</h2>
        </div>
        <div className="landing-pillars">
          {pillars.map(([title, body]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/*
        The API, on the page that decides whether anybody looks for it.


        The nine capabilities above describe what an organizer can do in the console and said
        nothing about the contract underneath it, so a reader evaluating Greenroom against a
        product that advertises an API had no reason to believe this one has a better story: the
        console is a client of the same routes, and the reference is generated from the schemas the
        server validates with. This is the claim; `/developers` is the argument for it.
      */}
      <section className="landing-section" aria-labelledby="api-title">
        <div className="landing-section-head">
          <h2 id="api-title">All of it over HTTP, too.</h2>
          <p>
            Every screen above is drawn by calling the same HTTP API you can call, and{" "}
            {CONTRACT.documentedOperations} of its operations are described by one OpenAPI document
            generated from the schemas the server validates requests with: scoped machine
            credentials that name the events they may touch, signed webhooks from a durable outbox,
            and credential-free reads of the published programme.
          </p>
        </div>
        <div className="landing-doors">
          <a className="landing-door secondary" {...linkProps(DEVELOPERS_PATH)}>
            How the API works
          </a>
        </div>
      </section>

      <section className="landing-section landing-trust" aria-labelledby="trust-title">
        <div>
          <h2 id="trust-title">Trust the system because you can verify it.</h2>
        </div>
        <div>
          <p>
            Greenroom keeps product behavior in specifications, validates its public contracts, and
            ships deterministic evidence for its core journeys.
          </p>
          <a className="landing-door on-dark" href={SOURCE_URL}>
            View source
          </a>
        </div>
      </section>

      <section className="landing-section landing-close" aria-labelledby="close-title">
        <h2 id="close-title">
          {doors?.demoMode ? "Start with the seeded conference" : "Start with your own event"}
        </h2>
        <p>
          {doors?.demoMode
            ? "Open the console as an organizer, then switch to a reviewer or a speaker to see the same event from the other side of it."
            : "Sign in and Greenroom provisions a workspace with a single event in it, waiting for its name and its timezone."}
        </p>
        <LandingDoors doors={doors} onSignedIn={onSignedIn} withAlternate={false} />
      </section>
    </>
  );
}

/**
 * The sign-in page, and the invitation link, which is the same page with a reason on it.
 *
 * One heading. The surface used to carry four — an eyebrow, an h1, the panel's own h2, and the
 * panel's lede — all saying "sign in" in slightly different words on a page whose only content
 * is a sign-in form. The panel is named by the h1 instead of restating it.
 */
function SignInSurface({
  doors,
  notice,
  onSignedIn,
  invitation,
}: {
  doors: AuthDoors | null;
  notice?: ReactNode;
  onSignedIn: (realSession: boolean) => void;
  /** The invitation this visitor followed, when that is why they are here. */
  invitation?: { token: string };
}) {
  return (
    <div className="landing-signin">
      <h1 id="landing-signin-title">{invitation ? "Accept your invitation" : "Sign in"}</h1>
      <p className="landing-lede">
        {invitation
          ? "Sign in first. The link names the invitation; the session you sign in with names the person accepting it, so Greenroom hands you the invitation again as soon as you are through."
          : doors?.demoMode
            ? "This deployment is seeded, so a role is all the identity it needs."
            : "Your workspace, the events you have a role on, and nothing that belongs to anyone else."}
      </p>
      {invitation && !invitation.token ? (
        <p className="landing-notice error" role="alert">
          That invitation link carried no token. Ask whoever invited you to send the link again.
        </p>
      ) : null}
      <SignInPanel
        doors={doors}
        variant="signin"
        labelledBy="landing-signin-title"
        onSignedIn={onSignedIn}
        {...(notice ? { notice } : {})}
      />
    </div>
  );
}

/**
 * What the page looks like while the probe is still out.
 *
 * The real header and the shape of the hero, not a sentence in the middle of an empty document.
 * It is the same `.landing-shell` element the answer renders into — same ground, same measure,
 * same bar in the same place — so the first paint is the page arriving rather than one colour
 * being replaced by another a round trip later.
 */
function LandingBoot({ active }: { active: Surface }) {
  return (
    <div className="landing-shell landing-boot">
      <LandingTopBar active={active} />
      <main>
        <div className="landing-hero" role="status">
          <div className="landing-hero-copy">
            <span className="landing-hidden">Loading Greenroom…</span>
            <span className="landing-bar is-title" />
            <span className="landing-bar is-title is-short" />
            <span className="landing-bar is-lede" />
            <span className="landing-bar is-lede is-short" />
            <span className="landing-bar is-door" />
          </div>
          <div className="landing-panel landing-panel-boot">
            <span className="landing-bar is-title is-short" />
            <span className="landing-bar is-lede" />
            <span className="landing-bar is-door" />
            <span className="landing-bar is-door" />
          </div>
        </div>
      </main>
    </div>
  );
}

export function LandingRoot({ bootstrap }: { bootstrap: Promise<LandingBootstrap> }) {
  const location = useLocation();
  const path = (location.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
  const search = location.split("?")[1] ?? "";
  const [doors, setDoors] = useState<AuthDoors | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  /*
   * The probe found a session, and the console has been asked for but has not arrived.
   *
   * Before `/developers` existed, `checking` alone covered this: it could only reach `false` on a
   * deployment that reported *no* session, so a session holder never saw the signed-out surface.
   * The public surface breaks that coupling — it clears `checking` with a session in hand — so a
   * signed-in reader leaving `/developers` for "/" fell through to the marketing hero, demo doors
   * and all, for as long as the ~300 kB console chunk took to load.
   */
  const [signedIn, setSignedIn] = useState(false);
  const mounted = useRef(true);

  const surface: Surface =
    path === ACCEPT_INVITATION_PATH
      ? "invitation"
      : path === DEVELOPERS_PATH
        ? "api"
        : path === "/signin"
          ? "signin"
          : "home";
  /*
   * The reference is public, so a session is not a reason to take the document away from it.
   *
   * Every other surface here hands over to the console the moment the probe reports a session,
   * because every other surface *is* the signed-out version of something the console owns. The
   * developer reference is not: it is a page about the product, and an organizer who follows a
   * link to it should read it rather than be bounced to their Overview. It is in the effect's
   * dependencies for the return journey — navigating from here to "/" flips this false, the
   * already-resolved probe is read again, and the hand-off happens then.
   */
  const publicSurface = surface === "api";
  const invitationToken =
    surface === "invitation" ? (new URLSearchParams(search).get("token") ?? "") : "";

  // Re-armed in the body, not only cleared in the cleanup: StrictMode runs a development mount
  // as mount → unmount → mount, so an effect that only ever clears this leaves the second mount
  // believing it is already gone, and every answer the probe brings back is dropped in dev.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Stashed on arrival rather than at the moment a door is pressed: the Google door is a plain
  // link that leaves the document, so there is no later moment this page still owns. Only while
  // this page is still the one on screen — once the console has the document the token is in the
  // URL it was handed, and re-stashing it would leave one behind for the next sign-in in the tab.
  useEffect(() => {
    if (workspace || !invitationToken) return;
    stashInvitationToken(invitationToken);
  }, [invitationToken, workspace]);

  /**
   * Hand the document to the console.
   *
   * The session is passed along when the probe already read one, so the shell does not ask the
   * same question twice on the same page load. `realSession` is only a pre-probe hint; once the
   * server reports an authentication kind, both real and demo sessions can be signed out.
   */
  const openWorkspace = useCallback((session: SessionDto | null, realSession: boolean) => {
    // ERROR-INTENT: callers cannot await; a console chunk that never arrives is reported below,
    // over the signed-out surface, which is the only thing this document still knows how to draw.
    void import("../App")
      .then(({ App }) => {
        if (!mounted.current) return;
        // The URL has to move before the console mounts, and only when the path it is on is not
        // one the console renders. `App` derives everything from the path, and no workspace
        // module claims `/signin` — so mounting it there paints "That workspace does not exist"
        // until its own allowlist effect runs and replaces the URL a frame later. Signing in
        // should not flash a not-found card at the person who just succeeded.
        //
        // An invitation is the other case, and it is why the token was stashed: whoever just
        // signed in did so to accept one, and the console's accept surface needs the token in
        // its own URL. Taken rather than read — a second sign-in in this tab is not a second
        // invitation.
        const token = takeInvitationToken();
        if (token)
          navigate(`${ACCEPT_INVITATION_PATH}?token=${encodeURIComponent(token)}`, {
            replace: true,
          });
        else if (window.location.pathname === "/signin") navigate("/", { replace: true });
        setWorkspace({ App, session, realSession });
      })
      .catch((reason: unknown) => {
        setError(describeIdentityFailure(reason));
        setChecking(false);
      });
  }, []);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await, and probeIdentity resolves with its own reason rather
    // than rejecting; both outcomes are rendered rather than logged and forgotten.
    void bootstrap
      .then((identity) => {
        if (!mounted.current) return;
        setDoors(identity.doors);
        if (identity.failure) setError(describeIdentityFailure(identity.failure));
        // A deployment offering demo personas cannot tell a real session from a persona at this
        // distance — both arrive in the same cookie. The session DTO carries the authoritative
        // authentication kind into the shell; this hint only covers an older API or first frame.
        if (identity.session) setSignedIn(true);
        if (identity.session && !publicSurface)
          openWorkspace(identity.session, identity.doors?.demoMode === false);
        else setChecking(false);
      })
      .catch((reason: unknown) => {
        setError(describeIdentityFailure(reason));
        setChecking(false);
      });
  }, [bootstrap, openWorkspace, publicSurface]);

  if (workspace) {
    const { App, session, realSession } = workspace;
    return <App {...(session ? { session } : {})} realSession={realSession} />;
  }

  /*
   * The reference does not wait for the probe.
   *
   * Nothing on it depends on who is reading, so gating it on the identity round trip would show a
   * skeleton of a hero that has no panel in it, for the length of a request whose answer the page
   * never reads. The probe still runs — the footer's demo link and the return journey to "/" both
   * come from it — it is just not on this surface's critical path.
   */
  if (!publicSurface && (checking || signedIn)) return <LandingBoot active={surface} />;

  /*
   * The callback sends every *refusal* to the same place without saying which check refused it,
   * so this says the same: something did not complete, and here are the doors again.
   *
   * `unavailable` is the one thing it does distinguish, and only because the fault is ours: D1
   * down, Google answering 5xx, provisioning failing part-way (issue #164). Telling somebody to
   * try their sign-in again when nothing about it was wrong sends them to check an account that
   * is fine. It is not an oracle either — a deployment being broken is not the answer to any
   * check a forged callback can pose.
   */
  const authOutcome = new URLSearchParams(search).get("auth");
  const authNotice =
    authOutcome === "failed"
      ? "That sign-in did not complete. Please try again."
      : authOutcome === "unavailable"
        ? "Sign-in is not working here at the moment, and that is our side rather than yours. Please try again shortly."
        : null;
  const notice =
    authNotice || error ? (
      <p className="landing-notice error" role="alert">
        {authNotice ?? error}
      </p>
    ) : null;

  return (
    <LandingChrome active={surface} doors={doors}>
      {surface === "api" ? (
        <ApiSurface />
      ) : surface === "home" ? (
        <LandingSurface
          doors={doors}
          onSignedIn={(realSession) => openWorkspace(null, realSession)}
          {...(notice ? { notice } : {})}
        />
      ) : (
        <SignInSurface
          doors={doors}
          onSignedIn={(realSession) => openWorkspace(null, realSession)}
          {...(surface === "invitation" ? { invitation: { token: invitationToken } } : {})}
          {...(notice ? { notice } : {})}
        />
      )}
    </LandingChrome>
  );
}
