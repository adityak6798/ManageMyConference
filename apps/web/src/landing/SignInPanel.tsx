/*
 * Every way into this deployment, rendered from what the deployment says it offers.
 *
 * One component serves both signed-out surfaces. On the landing page it is the panel beside
 * the headline, so an evaluator never has to find a second page before they are inside the
 * product; on `/signin` it is the page. The difference is what a visitor there is ready for —
 * a form to fill in — not which doors exist, so `variant` changes the composition and nothing
 * about which doors are offered.
 *
 * The doors themselves are decided by the API, never by this file: a button for a door the
 * deployment has not configured is a 404 with an inviting label on it.
 */

import { type FormEvent, type ReactNode, useState } from "react";
import {
  type AuthDoors,
  describeIdentityFailure,
  requestLoginCode,
  startDemoSession,
  verifyLoginCode,
} from "../api/identity";
import { apiBase } from "../api/config";
import { useLinkProps } from "../router";

const personas = ["organizer", "reviewer", "speaker", "public"] as const;

/**
 * What each seeded identity is for, so the four buttons are a choice rather than a quiz. The
 * console itself never explains these — it is the product, not a walkthrough — so the sentence
 * belongs on the door.
 */
const personaPurpose: Record<(typeof personas)[number], string> = {
  organizer: "the whole workspace: proposals, review, schedule, speakers, publishing",
  reviewer: "a blind queue and the rubric, and nothing else",
  speaker: "one speaker's portal: their tasks, profile, and session",
  public: "what an attendee sees, with no workspace behind it",
};

export function SignInPanel({
  doors,
  variant,
  notice,
  onSignedIn,
}: {
  doors: AuthDoors | null;
  variant: "landing" | "signin";
  /** Something the surface already knows and this panel does not, such as a refused callback. */
  notice?: ReactNode;
  /** The session is live. `realSession` distinguishes durable login from a demo persona. */
  onSignedIn: (realSession: boolean) => void;
}) {
  const linkProps = useLinkProps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");

  async function choosePersona(persona: (typeof personas)[number]) {
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

  async function submitCode(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // One form, two steps: the address earns a challenge, the code spends it.
      if (!challenge) setChallenge((await requestLoginCode(email)).challenge);
      else {
        await verifyLoginCode(challenge, code);
        onSignedIn(true);
      }
    } catch (reason: unknown) {
      setError(describeIdentityFailure(reason));
    } finally {
      setBusy(false);
    }
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

  return (
    // The anchor target of the landing page's second door, and focusable so that door actually
    // moves a keyboard user rather than only scrolling the page under them.
    <section
      className="landing-panel"
      id="signin-panel"
      tabIndex={-1}
      aria-labelledby="signin-panel-title"
    >
      <h2 id="signin-panel-title">{doors?.demoMode ? "Ten minutes, no account" : "Get started"}</h2>
      {notice}
      {error ? (
        <p className="landing-notice error" role="alert">
          {error}
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
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; choosePersona renders its own failure.
                    void choosePersona(persona);
                  }}
                >
                  Continue as {persona}
                </button>
                <span className="landing-persona-note">{personaPurpose[persona]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {doors && !doors.demoMode ? (
        <p className="landing-panel-lede">
          {doors.google
            ? "Sign in with Google. First time through provisions your organization and one event to work in — there is nothing to configure before that."
            : "Sign in with the address your event account uses, and we will email you a code."}
        </p>
      ) : null}

      {google}

      {doors && !doors.demoMode && variant === "signin" ? (
        <form className="landing-form" onSubmit={submitCode}>
          <div className="landing-field">
            <label htmlFor={challenge ? "signin-code" : "signin-email"}>
              {challenge ? "Six-digit code" : "Email address"}
            </label>
            <input
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
          <button type="submit" className="landing-door" disabled={busy}>
            {challenge ? "Sign in" : "Email me a code"}
          </button>
          {challenge ? (
            <button
              type="button"
              className="landing-door secondary"
              disabled={busy}
              onClick={() => {
                setChallenge("");
                setCode("");
                setError(null);
              }}
            >
              Request a new code
            </button>
          ) : null}
        </form>
      ) : null}

      {doors && !doors.demoMode && variant === "landing" ? (
        <p className="landing-panel-note">
          <a {...linkProps("/signin")}>Other ways to sign in</a>
        </p>
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
