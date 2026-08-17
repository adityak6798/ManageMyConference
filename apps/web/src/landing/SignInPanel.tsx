/*
 * Every way into this deployment, rendered from what the deployment says it offers.
 *
 * One component serves both signed-out surfaces. On the landing page it is the panel beside
 * the headline, so an evaluator never has to find a second page before they are inside the
 * product; on `/signin` and on an invitation link it is the page. The difference is the
 * composition — whether it names itself, and how much it explains — and never which doors are
 * offered. Gating a door on the variant is what left an emailed-code deployment with a landing
 * panel containing a heading, a sentence, and no way in at all.
 *
 * The doors themselves are decided by the API, never by this file: a button for a door the
 * deployment has not configured is a 404 with an inviting label on it.
 */

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { apiBase } from "../api/config";
import {
  type AuthDoors,
  describeIdentityFailure,
  requestLoginCode,
  startDemoSession,
  verifyLoginCode,
} from "../api/identity";

const personas = ["organizer", "reviewer", "speaker", "public"] as const;

type Persona = (typeof personas)[number];

/**
 * What each seeded identity is for, so the four buttons are a choice rather than a quiz. The
 * console itself never explains these — it is the product, not a walkthrough — so the sentence
 * belongs on the door.
 */
const personaPurpose: Record<Persona, string> = {
  organizer: "the whole workspace: proposals, review, schedule, speakers, publishing",
  reviewer: "a blind queue and the rubric, and nothing else",
  speaker: "one speaker's portal: their tasks, profile, and session",
  public: "what an attendee sees, with no workspace behind it",
};

/** One demo door: press it, and either the console arrives or this says why it did not. */
export type DemoDoor = {
  busy: boolean;
  error: string | null;
  start: (persona: Persona) => void;
};

/**
 * The seeded sign-in, as a hook, so the hero's primary can be the door rather than a link to a
 * page that shows a strict subset of what is already on screen.
 *
 * Each caller holds its own, deliberately: a failure belongs beside the control that was
 * pressed, and this page shows the doors in three places.
 */
export function useDemoDoor(onSignedIn: (realSession: boolean) => void): DemoDoor {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(persona: Persona) {
    setBusy(true);
    setError(null);
    try {
      await startDemoSession(persona);
      onSignedIn(false);
    } catch (reason: unknown) {
      setError(describeIdentityFailure(reason));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    start(persona) {
      // ERROR-INTENT: handlers cannot await; `open` renders its own failure through `error`.
      void open(persona);
    },
  };
}

export function SignInPanel({
  doors,
  variant,
  notice,
  labelledBy,
  onSignedIn,
}: {
  doors: AuthDoors | null;
  variant: "landing" | "signin";
  /** Something the surface already knows and this panel does not, such as a refused callback. */
  notice?: ReactNode;
  /**
   * The heading that already names this panel, on a surface whose whole content it is. Passing
   * it suppresses the panel's own — a page about signing in does not need a second heading that
   * also says "sign in".
   */
  labelledBy?: string;
  /** The session is live. `realSession` distinguishes durable login from a demo persona. */
  onSignedIn: (realSession: boolean) => void;
}) {
  const demo = useDemoDoor(onSignedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  /** The address the outstanding code went to. Empty until one has been asked for. */
  const [sentTo, setSentTo] = useState("");
  const [resent, setResent] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // The code field is a new element, not the address field wearing a different `type` — see the
  // `key` below — so focus has to be moved to it deliberately. Without this the caret stays on a
  // field that no longer exists and the transition is silent for anybody not watching the panel.
  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);

  async function submitCode(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // One form, two steps: the address earns a challenge, the code spends it.
      if (!challenge) {
        setChallenge((await requestLoginCode(email)).challenge);
        setSentTo(email);
      } else {
        await verifyLoginCode(challenge, code);
        onSignedIn(true);
      }
    } catch (reason: unknown) {
      setError(describeIdentityFailure(reason));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask for another code for the same address.
   *
   * This used to clear the challenge, which is not a new code — it is the first step again, with
   * the address the reader already typed thrown away. A code that never arrived is the one case
   * this button exists for, so it re-issues.
   */
  async function resend() {
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      setChallenge((await requestLoginCode(sentTo)).challenge);
      setCode("");
      setResent(true);
    } catch (reason: unknown) {
      setError(describeIdentityFailure(reason));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setChallenge("");
    setCode("");
    setSentTo("");
    setResent(false);
    setError(null);
  }

  const google = doors?.google ? (
    // A plain link, because the route answers with a redirect to Google rather than with JSON.
    // Fetching it would follow the redirect in the background and land the response in script,
    // where a cross-origin consent screen cannot be shown and the whole flow dies quietly.
    //
    // Built from `apiBase` for the same reason every other call is: a separately hosted frontend
    // (`VITE_API_BASE_URL`) serves this document from an origin that has no `/api` on it, so a
    // root-relative href would navigate to the frontend host and 404 — while the probes that
    // decided to render this button had gone to the API. Empty by default, which leaves the
    // local proxy and the same-origin Worker deployment exactly as they were.
    <a className="landing-door" href={`${apiBase}/api/auth/google/start`}>
      Continue with Google
    </a>
  ) : null;

  const emailDoor = doors && !doors.demoMode;

  return (
    // The anchor target of the landing page's second door, and focusable so that door actually
    // moves a keyboard user rather than only scrolling the page under them.
    <section
      className="landing-panel"
      id="signin-panel"
      tabIndex={-1}
      aria-labelledby={labelledBy ?? "signin-panel-title"}
    >
      {labelledBy ? null : (
        <h2 id="signin-panel-title">{doors?.demoMode ? "Ten minutes, no account" : "Sign in"}</h2>
      )}
      {/* What this deployment actually is, in the face the product uses for every other
          measurement. It is the panel's first line because it decides everything under it. */}
      <p className="figure landing-deployment">
        {doors === null
          ? "deployment did not answer"
          : doors.demoMode
            ? "seeded demo deployment"
            : doors.google
              ? "google sign-in + emailed code"
              : "emailed sign-in code"}
      </p>
      {notice}
      {error ? (
        <p className="landing-notice error" role="alert">
          {error}
        </p>
      ) : null}
      {demo.error ? (
        <p className="landing-notice error" role="alert">
          {demo.error}
        </p>
      ) : null}

      {doors === null ? (
        <>
          <p className="landing-panel-lede">
            This deployment did not say which ways in it offers, so none are shown rather than
            offering one that cannot work.
          </p>
          <button type="button" className="landing-door" onClick={() => window.location.reload()}>
            Try again
          </button>
        </>
      ) : null}

      {doors?.demoMode ? (
        <>
          <p className="landing-panel-lede">
            This deployment runs on a seeded conference. Pick who you are and you are inside the
            console — each identity sees exactly what its role grants, and nothing else.
          </p>
          <ul className="landing-personas">
            {personas.map((persona) => (
              <li key={persona}>
                <button
                  type="button"
                  className="landing-persona"
                  disabled={demo.busy}
                  onClick={() => demo.start(persona)}
                >
                  Continue as {persona}
                </button>
                <span className="landing-persona-note">{personaPurpose[persona]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {emailDoor ? (
        <p className="landing-panel-lede">
          {doors.google
            ? "Sign in with Google, or with the address your event account uses. First time through provisions your organization and one event to work in — there is nothing to configure before that."
            : "Sign in with the address your event account uses, and we will email you a six-digit code."}
        </p>
      ) : null}

      {google}

      {emailDoor ? (
        <form className="landing-form" onSubmit={submitCode}>
          {google ? (
            <p className="landing-or" aria-hidden="true">
              or
            </p>
          ) : null}
          <div className="landing-field">
            <label htmlFor={challenge ? "signin-code" : "signin-email"}>
              {challenge ? "Six-digit code" : "Email address"}
            </label>
            <input
              // Keyed on the step, so React replaces the field rather than mutating `type` and
              // `autocomplete` on the one already there. A password manager that has filled an
              // email field does not expect it to become a one-time-code field underneath it,
              // and mutating in place is how the address ends up saved as the code.
              key={challenge ? "code" : "email"}
              ref={codeRef}
              id={challenge ? "signin-code" : "signin-email"}
              type={challenge ? "text" : "email"}
              inputMode={challenge ? "numeric" : undefined}
              autoComplete={challenge ? "one-time-code" : "email"}
              value={challenge ? code : email}
              onChange={(changeEvent) =>
                challenge ? setCode(changeEvent.target.value) : setEmail(changeEvent.target.value)
              }
              required
            />
          </div>
          {challenge ? (
            // Announced, because the whole panel changed in response to a press: the field is a
            // different field, and the address it went to is the thing worth checking first.
            <p className="landing-panel-note" role="status">
              {resent ? "A new code is on its way to " : "We sent a six-digit code to "}
              <span className="figure">{sentTo}</span>. It is good for a few minutes.
            </p>
          ) : null}
          <button type="submit" className="landing-door" disabled={busy}>
            {challenge ? "Sign in" : "Email me a code"}
          </button>
          {challenge ? (
            <div className="landing-form-alternates">
              <button
                type="button"
                className="landing-door secondary"
                disabled={busy}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; `resend` renders its own failure.
                  void resend();
                }}
              >
                Send a new code
              </button>
              <button type="button" className="landing-link" disabled={busy} onClick={startOver}>
                Use a different address
              </button>
            </div>
          ) : null}
        </form>
      ) : null}

      {doors?.demoMode && variant === "landing" ? (
        <p className="landing-panel-note">
          Nothing you do here reaches anyone: the seeded conference resets on command, and no mail
          leaves the deployment.
        </p>
      ) : null}
    </section>
  );
}
