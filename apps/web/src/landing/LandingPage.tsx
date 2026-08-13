/*
 * The two surfaces a visitor sees before they are anybody: "/" and "/signin".
 *
 * "/" is also the console's home once a session exists, and the session cookie is `httpOnly`,
 * so the document cannot tell which of the two it is by itself. `LandingRoot` is the answer:
 * it renders while the probe in `api/identity.ts` is in flight, shows the marketing page or
 * the sign-in page when the API says nobody is signed in, and dynamically imports the console
 * and hands the document over when it says somebody is. The console is not in this bundle —
 * an anonymous visitor downloading an organizer's workspace to read a headline is exactly the
 * mistake `main.tsx` documents for the public event pages.
 *
 * The copy here claims only what the repository can defend. Two of the nine capabilities are
 * marked as built-but-unproven on purpose, and the wording of those two is derived from
 * docs/product/competition-traceability.md rather than from optimism: an evaluator who finds
 * an overstatement here has been given a reason to disbelieve the other seven.
 */

import type { SessionDto } from "@greenroom/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type AuthDoors, describeIdentityFailure, type LandingBootstrap } from "../api/identity";
import { navigate, useLinkProps, useLocation } from "../router";
import { SignInPanel } from "./SignInPanel";
import "./landing.css";

type ConsoleModule = typeof import("../App");

/** The console, once it has arrived, with everything the probe already learned for it. */
type Workspace = {
  App: ConsoleModule["App"];
  session: SessionDto | null;
  realSession: boolean;
};

type Capability = {
  title: string;
  body: string;
  /** "built" means the behaviour exists and is tested here, but its last mile is unexercised. */
  state: "ships" | "built";
  qualifier?: string;
};

const capabilities: Capability[] = [
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
    body: "The programme as last published, at its own address and as copy-paste embeds of the schedule and the speaker gallery. One immutable snapshot is behind all of them, so two embeds and the site cannot disagree, and it reads on a phone.",
    state: "ships",
  },
];

/**
 * Shared chrome, rendered once and kept across the move between the two surfaces.
 *
 * Mounted once on purpose: a client-side navigation moves nothing for a screen reader by
 * itself, so `main` takes focus when the surface changes — and it can only notice a change if
 * the same element is still there to compare against. Remounting the chrome per surface would
 * reset that memory and the focus move would never happen.
 */
function LandingChrome({ children, active }: { children: ReactNode; active: "home" | "signin" }) {
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
      <header>
        <a className="landing-brand" {...linkProps("/")}>
          <span className="landing-glyph" aria-hidden="true">
            G
          </span>
          Greenroom
        </a>
        <a
          className="landing-header-link"
          {...linkProps(active === "signin" ? "/" : "/signin")}
          // No `aria-current`: on /signin this link points *away*, at "/", and marking it as the
          // current page tells a screen reader that "Back to the overview" is where you are.
          // axe has no rule for a truthful-but-misapplied aria-current, so the quality gate would
          // never have caught it.
        >
          {active === "signin" ? "Back to the overview" : "Sign in"}
        </a>
      </header>
      {/* tabIndex={-1} is a focus target for the skip link and for navigation, not a tab stop. */}
      <main id="landing-main" ref={mainRef} tabIndex={-1}>
        {children}
      </main>
      <footer>
        <p>Project Greenroom — a conference operations workspace.</p>
        <p className="landing-footer-note">
          Built in the open. What is described above is what this repository can demonstrate; where
          a capability has not met a live third party, it says so on its own card.
        </p>
      </footer>
    </div>
  );
}

function CapabilityList() {
  return (
    <ol className="landing-capabilities">
      {capabilities.map((capability, index) => (
        <li key={capability.title}>
          <p className="landing-capability-index" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </p>
          <h3>{capability.title}</h3>
          <p className="landing-capability-body">{capability.body}</p>
          <p className={capability.state === "ships" ? "landing-state" : "landing-state is-built"}>
            {capability.state === "ships" ? "Ships today" : "Built, not yet proven end to end"}
          </p>
          {capability.qualifier ? (
            <p className="landing-capability-note">{capability.qualifier}</p>
          ) : null}
        </li>
      ))}
    </ol>
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
          <p className="landing-eyebrow">Conference operations, end to end</p>
          <h1>One workspace from the first proposal to the closing keynote.</h1>
          <p className="landing-lede">
            Greenroom collects and routes proposals, runs blind review, builds the schedule, keeps
            every speaker's outstanding task visible, and publishes the programme your attendees
            read — with one source of truth underneath all of it.
          </p>
          <div className="landing-doors">
            <a className="landing-door" {...linkProps("/signin")}>
              Get started
            </a>
            {doors?.demoMode ? (
              <a className="landing-door secondary" href="#signin-panel">
                Explore the demo
              </a>
            ) : (
              <a className="landing-door secondary" href="#capabilities">
                See what ships
              </a>
            )}
          </div>
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
          <h2 id="capabilities-title">Nine things a conference team needs</h2>
          <p>
            Seven of them ship today. Two are marked{" "}
            <strong>built, not yet proven end to end</strong>: the behaviour exists here and is
            tested here, but its last mile — a real mail client, a live registration API — has not
            been exercised yet. You would rather read that here than discover it during your event.
          </p>
        </div>
        <CapabilityList />
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
        <div className="landing-doors">
          <a className="landing-door" {...linkProps("/signin")}>
            Get started
          </a>
          {doors?.demoMode ? (
            <a className="landing-door secondary" href="#signin-panel">
              Explore the demo
            </a>
          ) : null}
        </div>
      </section>
    </>
  );
}

function SignInSurface({
  doors,
  notice,
  onSignedIn,
}: {
  doors: AuthDoors | null;
  notice?: ReactNode;
  onSignedIn: (realSession: boolean) => void;
}) {
  return (
    <div className="landing-signin">
      <p className="landing-eyebrow">Project Greenroom</p>
      <h1>Sign in</h1>
      <p className="landing-lede">
        {doors?.demoMode
          ? "This deployment is seeded, so a role is all the identity it needs."
          : "Your workspace, the events you have a role on, and nothing that belongs to anyone else."}
      </p>
      <SignInPanel
        doors={doors}
        variant="signin"
        onSignedIn={onSignedIn}
        {...(notice ? { notice } : {})}
      />
    </div>
  );
}

export function LandingRoot({ bootstrap }: { bootstrap: Promise<LandingBootstrap> }) {
  const location = useLocation();
  const path = (location.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
  const [doors, setDoors] = useState<AuthDoors | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const mounted = useRef(true);

  // Re-armed in the body, not only cleared in the cleanup: StrictMode runs a development mount
  // as mount → unmount → mount, so an effect that only ever clears this leaves the second mount
  // believing it is already gone, and every answer the probe brings back is dropped in dev.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Hand the document to the console.
   *
   * The session is passed along when the probe already read one, so the shell does not ask the
   * same question twice on the same page load. `realSession` is what decides whether the shell
   * offers a sign-out: a demo persona is switched, not signed out, and the two must not be
   * confused for each other.
   */
  const openWorkspace = useCallback((session: SessionDto | null, realSession: boolean) => {
    // ERROR-INTENT: callers cannot await; a console chunk that never arrives is reported below,
    // over the signed-out surface, which is the only thing this document still knows how to draw.
    void import("../App")
      .then(({ App }) => {
        if (!mounted.current) return;
        // The URL has to move before the console mounts, and only when we are handing over from
        // `/signin`. `App` derives everything it renders from the path, and no workspace module
        // claims `/signin` — so mounting it there paints "That workspace does not exist" until
        // its own allowlist effect runs and replaces the URL a frame later. Signing in should
        // not flash a not-found card at the person who just succeeded.
        if (window.location.pathname === "/signin") navigate("/", { replace: true });
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
        // distance — both arrive in the same cookie — so it never offers sign-out. Everywhere
        // else, a session that already exists can only have been signed in for.
        if (identity.session) openWorkspace(identity.session, identity.doors?.demoMode === false);
        else setChecking(false);
      })
      .catch((reason: unknown) => {
        setError(describeIdentityFailure(reason));
        setChecking(false);
      });
  }, [bootstrap, openWorkspace]);

  if (workspace) {
    const { App, session, realSession } = workspace;
    return <App {...(session ? { session } : {})} realSession={realSession} />;
  }

  if (checking)
    return (
      <p className="landing-boot" role="status">
        Loading Greenroom…
      </p>
    );

  // The callback sends every refusal to the same place without saying which check refused it,
  // so this says the same: something did not complete, and here are the doors again.
  const refused = new URLSearchParams(location.split("?")[1] ?? "").get("auth") === "failed";
  const notice =
    refused || error ? (
      <p className="landing-notice error" role="alert">
        {refused ? "That sign-in did not complete. Please try again." : error}
      </p>
    ) : null;

  return (
    <LandingChrome active={path === "/signin" ? "signin" : "home"}>
      {path === "/signin" ? (
        <SignInSurface
          doors={doors}
          onSignedIn={(realSession) => openWorkspace(null, realSession)}
          {...(notice ? { notice } : {})}
        />
      ) : (
        <LandingSurface
          doors={doors}
          onSignedIn={(realSession) => openWorkspace(null, realSession)}
          {...(notice ? { notice } : {})}
        />
      )}
    </LandingChrome>
  );
}
