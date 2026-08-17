/** Anonymous organization portal and consent-stamped registration. @spec PRD-PUB-002 */
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import type { PublicSiteDto } from "@greenroom/contracts";
import { SiteApiError, readPublicSite, readPublicSitePage, registerForSite } from "./api/sites";
/*
 * Both stylesheets, explicitly.
 *
 * The portal wears `.public-shell` and every piece of furniture hung off it — the header, the
 * nav, the lede, the section rhythm — all of which live in public-event.css. It imported only
 * public-pages.css and rendered correctly anyway, because the entry chunk happens to pull the
 * event pages in beside it. Splitting the bundle differently would have left this page bare.
 */
import "./public-event.css";
import "./styles/public-pages.css";
import { PageSkeleton } from "./public-event/cards";
import { Select } from "./ui/fields";

const routeFromPath = () => {
  const match = window.location.pathname.match(/^\/sites\/([^/]+)(?:\/pages\/([^/]+))?\/?$/);
  if (!match?.[1]) return "";
  try {
    return {
      slug: decodeURIComponent(match[1]),
      pageSlug: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    // ERROR-INTENT: a malformed anonymous path is the same unavailable portal as an unknown slug.
    return "";
  }
};

/** How the transport keys a refusal about one of the portal's own questions: the Zod path. */
const ANSWER_PATH_PREFIX = "answers.";

/**
 * The envelope's refusals, re-keyed onto the controls this page actually draws.
 *
 * The server validates the whole submission at once, so a refused answer comes back under its
 * position in the payload — `answers.diet`, never `diet` — and the question's own lookup was for
 * the bare key, which is why the one refusal the server raises about a custom question was the
 * one the highlight could never draw. Only a prefix naming a *published* question is stripped:
 * `answers.name` for a question this portal does not offer must not land on the Name field.
 */
function errorsByControl(
  fieldErrors: Record<string, string[]>,
  questions: readonly { key: string }[],
): Record<string, string[]> {
  const published = new Set(questions.map((question) => question.key));
  const byControl: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const answered = key.startsWith(ANSWER_PATH_PREFIX) ? key.slice(ANSWER_PATH_PREFIX.length) : "";
    const control = published.has(answered) ? answered : key;
    byControl[control] = [...(byControl[control] ?? []), ...messages];
  }
  return byControl;
}

/** What ties a control to the refusal drawn under it, and nothing at all when it has none. */
const refusalProps = (id: string, messages: readonly string[]) =>
  messages.length > 0 ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};

/** The refusals under one control, at the id that control's `aria-describedby` points at. */
function FieldRefusal({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="pub-field-errors" id={`${id}-error`}>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

export function PublicSiteApp() {
  const [site, setSite] = useState<PublicSiteDto | null>(null);
  const [page, setPage] = useState<{
    site: { slug: string; name: string };
    page: { title: string; bodyHtml: string };
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<number | null>(null);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  /**
   * Refusals keyed by control, from either half of the check below.
   *
   * The banner says "Review the highlighted registration details."; this is what does the
   * highlighting. Without it the sentence names something the page never draws.
   */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const route = routeFromPath();
  const slug = typeof route === "string" ? "" : route.slug;
  const pageSlug = typeof route === "string" ? null : route.pageSlug;

  useEffect(() => {
    let active = true;
    const request = pageSlug ? readPublicSitePage(slug, pageSlug) : readPublicSite(slug);
    // ERROR-INTENT: this effect renders both success and rejection; React cannot await it.
    void request
      .then((loaded) => {
        if (!active) return;
        if ("page" in loaded) setPage(loaded);
        else setSite(loaded.site);
      })
      // ERROR-INTENT: public capability-style routes deliberately make unknown and unpublished
      // portals indistinguishable; the visitor gets the one useful recovery state.
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [pageSlug, slug]);

  /**
   * Drop the refusal about one control, because the reader has just changed it.
   *
   * A refusal that named this field stops being true the moment it is edited; leaving it on
   * screen makes the reader doubt the answer they have now given.
   */
  const forgetFieldError = (key: string) =>
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const { [key]: _answered, ...rest } = current;
      return rest;
    });

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Held rather than read after the await: React clears `currentTarget` once the handler
    // returns, so reaching for it again threw a TypeError the catch below then reported as a
    // registration failure — over a registration that had already succeeded.
    const form = event.currentTarget;
    const data = new FormData(form);
    setRegistrationError(null);
    /*
     * The unanswered question is refused here, on the question, before the request.
     *
     * A required `select` used to be a native one, so constraint validation blocked the submit
     * and focused it. The shared listbox is a `<button role="combobox">` — constraint validation
     * cannot see it, and the hidden mirror it can emit is exempt anyway — so the only refusal
     * left was the server's, which arrives as "Review the highlighted registration details." on
     * a form that highlighted nothing. Text questions still carry a native `required` and never
     * reach this, so in practice this is the select's guard.
     */
    const unanswered = site?.registrationFields.filter(
      (field) => field.required && !(answers[field.key] ?? "").trim(),
    );
    const first = unanswered?.[0];
    if (unanswered && first) {
      setFieldErrors(
        Object.fromEntries(unanswered.map((field) => [field.key, [`${field.label} is required.`]])),
      );
      // Focus carries the message: the control's own `aria-describedby` now points at it, which
      // is what the native refusal did. A banner repeating it would say it twice.
      document.getElementById(`portal-${first.key}`)?.focus();
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const result = await registerForSite(slug, {
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        accepted: data.get("accepted") === "on",
        answers,
      });
      setRegistered(result.noticeVersion);
      form.reset();
      setAnswers({});
    } catch (error) {
      // ERROR-INTENT: the anonymous form keeps the entered fields and renders the API refusal —
      // the per-field half beside the control it names, because the message promises a
      // highlight and the envelope carries everything needed to draw one. Re-keyed on the way
      // in so the state this page reads is always keyed the way this page draws.
      if (error instanceof SiteApiError)
        setFieldErrors(errorsByControl(error.fieldErrors, site?.registrationFields ?? []));
      setRegistrationError(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  if (unavailable)
    return (
      <div className="public-shell">
        <header>
          <a className="brand" href="/">
            Greenroom
          </a>
        </header>
        <main className="pub-state">
          <h1>This portal is not available</h1>
          <p className="pub-note">
            It is either unpublished or the address has changed. If somebody sent you this link, ask
            them for the current one.
          </p>
        </main>
      </div>
    );
  if (page)
    return (
      <div className="public-shell">
        <header>
          <a className="brand" href={`/sites/${page.site.slug}`}>
            {page.site.name}
          </a>
        </header>
        <main>
          <div className="pub-head">
            <h1>{page.page.title}</h1>
          </div>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: publishing sanitizes this HTML before storage and serves only the sanitized projection. */}
          <div className="pub-prose" dangerouslySetInnerHTML={{ __html: page.page.bodyHtml }} />
        </main>
        <footer>{page.site.name}</footer>
      </div>
    );
  if (!site)
    return (
      <div className="public-shell">
        <header>
          <span className="brand">Greenroom</span>
        </header>
        <main className="pub-state">
          <PageSkeleton label="Loading this portal" />
        </main>
      </div>
    );

  /*
   * A refusal with nowhere to land.
   *
   * The banner promises a highlight, so every key the envelope carries has to reach either a
   * control or this sentence. `request` — a body the server could not read at all — and an answer
   * to a question this portal has since stopped publishing both arrive with no control to sit
   * under, and dropping them left the reader a sentence pointing at nothing.
   */
  const drawn = new Set([
    "name",
    "email",
    ...(site.privacyNotice ? ["accepted"] : []),
    ...site.registrationFields.map((field) => field.key),
  ]);
  const undrawn = Object.entries(fieldErrors)
    .filter(([key]) => !drawn.has(key))
    .flatMap(([, messages]) => messages);

  return (
    /*
     * The portal's one point of difference is the organization's own colour, set here as
     * `--accent`; public-pages.css derives the hover shade — and only the hover shade — from it
     * on this same element. The matching `--accent-soft` tint is deliberately gone with the
     * three things that used it, and is still defined at `:root` as Greenroom's own green, so a
     * public surface must not reach for it expecting the organization's colour.
     * The `theme-${site.theme}` class it also carried matched no rule in any
     * stylesheet — light, dark and auto all rendered identically — so it is gone rather than
     * left implying a choice the surface does not honour.
     */
    <div className="public-shell" style={{ "--accent": site.primaryColor } as CSSProperties}>
      <header>
        <span className="brand">{site.name}</span>
        {site.pages.length > 0 ? (
          <nav aria-label="Portal pages">
            {site.pages.map((page) => (
              <a key={page.slug} href={`/sites/${site.slug}/pages/${page.slug}`}>
                {page.title}
              </a>
            ))}
          </nav>
        ) : null}
      </header>
      <main>
        <section className="pub-hero">
          <h1>{site.landing.heading || site.name}</h1>
          {site.tagline ? <p className="lede">{site.tagline}</p> : null}
          {site.landing.body ? <p className="pub-note">{site.landing.body}</p> : null}
        </section>

        {site.programs.length > 0 ? (
          <section className="pub-section" aria-labelledby="portal-programs">
            <div className="pub-section-head">
              <h2 id="portal-programs">Programs</h2>
            </div>
            <ul className="pub-proposal-list">
              {site.programs.map((program) => (
                <li className="pub-invite" key={`${program.kind}:${program.ref}`}>
                  <div>
                    <p className="pub-proposal-title">
                      <a href={program.href}>{program.title ?? program.label}</a>
                    </p>
                    {program.state ? <p className="pub-note">{program.state}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="pub-section" aria-labelledby="portal-register">
          <div className="pub-section-head">
            <h2 id="portal-register">{site.login.heading || "Register"}</h2>
          </div>
          {site.login.body ? <p className="pub-note">{site.login.body}</p> : null}
          {registered ? (
            <p className="pub-notice" role="status">
              Registered. You accepted privacy notice version {registered}.
            </p>
          ) : (
            /*
              The same form vocabulary the call for proposals uses. This was `className="stack"`
              — a class with no matching rule anywhere the portal loads — so eight label/input
              pairs stacked with no separation at all and the submit button fell through to
              whatever the console's global button rule happened to be.
            */
            <form className="pub-form" onSubmit={register}>
              {/*
                The built-in three carry the same highlight as a custom question, because the
                server refuses them by the same route. `type=email` is the WHATWG regex, which
                accepts "pat@localhost" and "pat@gmail"; `z.string().email()` on the server does
                not — so the browser submits, the transport answers 400 with `email`, and this is
                the field that has to show it. Every portal has these three; most have no custom
                question at all, so without this the highlight was missing from the common form.
              */}
              <div className="pub-form-field">
                <label htmlFor="portal-name">
                  Name
                  <span className="pub-req" aria-hidden="true">
                    Required
                  </span>
                </label>
                <input
                  className="control"
                  id="portal-name"
                  name="name"
                  required
                  maxLength={160}
                  {...refusalProps("portal-name", fieldErrors.name ?? [])}
                  onChange={() => forgetFieldError("name")}
                />
                <FieldRefusal id="portal-name" messages={fieldErrors.name ?? []} />
              </div>
              <div className="pub-form-field">
                <label htmlFor="portal-email">
                  Email
                  <span className="pub-req" aria-hidden="true">
                    Required
                  </span>
                </label>
                <input
                  className="control"
                  id="portal-email"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  {...refusalProps("portal-email", fieldErrors.email ?? [])}
                  onChange={() => forgetFieldError("email")}
                />
                <FieldRefusal id="portal-email" messages={fieldErrors.email ?? []} />
              </div>
              {site.registrationFields.map((field) => {
                const id = `portal-${field.key}`;
                const value = answers[field.key] ?? "";
                const errors = fieldErrors[field.key] ?? [];
                const answer = (next: string) => {
                  setAnswers((current) => ({ ...current, [field.key]: next }));
                  forgetFieldError(field.key);
                };
                return (
                  <div className="pub-form-field" key={field.key}>
                    {field.kind === "select" ? (
                      // The shared control brings its own label, hint and error, so the refusal
                      // is handed to it rather than drawn beside it twice.
                      <Select
                        id={id}
                        error={errors.length > 0 ? errors : undefined}
                        label={
                          <>
                            {field.label}
                            {field.required ? (
                              <span className="pub-req" aria-hidden="true">
                                Required
                              </span>
                            ) : null}
                          </>
                        }
                        required={field.required}
                        value={value || null}
                        onChange={answer}
                        placeholder="Choose an option"
                        options={field.options.map((option) => ({
                          value: option,
                          label: option,
                        }))}
                      />
                    ) : (
                      <>
                        <label htmlFor={id}>
                          {field.label}
                          {field.required ? (
                            <span className="pub-req" aria-hidden="true">
                              Required
                            </span>
                          ) : null}
                        </label>
                        <input
                          className="control"
                          id={id}
                          required={field.required}
                          value={value}
                          {...refusalProps(id, errors)}
                          onChange={(change) => answer(change.target.value)}
                        />
                        <FieldRefusal id={id} messages={errors} />
                      </>
                    )}
                  </div>
                );
              })}
              {site.privacyNotice ? (
                <div className="pub-form-field">
                  <div
                    className="pub-prose pub-hint"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: publishing sanitizes this HTML before storage and versions that exact projection.
                    dangerouslySetInnerHTML={{ __html: site.privacyNotice.bodyHtml }}
                  />
                  {/* The label wraps the control, so the sentence is the accessible name and
                      clicking anywhere in it ticks the box. */}
                  <label className="pub-consent">
                    <input
                      name="accepted"
                      type="checkbox"
                      required
                      {...refusalProps("portal-accepted", fieldErrors.accepted ?? [])}
                      onChange={() => forgetFieldError("accepted")}
                    />
                    <span>I accept privacy notice version {site.privacyNotice.version}.</span>
                  </label>
                  <FieldRefusal id="portal-accepted" messages={fieldErrors.accepted ?? []} />
                </div>
              ) : null}
              <div className="pub-form-actions">
                <button className="primary" type="submit" disabled={busy || !site.privacyNotice}>
                  {busy ? "Registering…" : "Register"}
                </button>
              </div>
              {registrationError ? (
                <p className="pub-notice is-error" role="alert">
                  {[registrationError, ...undrawn].join(" ")}
                </p>
              ) : null}
            </form>
          )}
        </section>
      </main>
      <footer>{site.name}</footer>
    </div>
  );
}
