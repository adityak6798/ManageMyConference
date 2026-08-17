/** Anonymous organization portal and consent-stamped registration. @spec PRD-PUB-002 */
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import type { PublicSiteDto } from "@greenroom/contracts";
import { readPublicSite, readPublicSitePage, registerForSite } from "./api/sites";
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

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setRegistrationError(null);
    setBusy(true);
    try {
      const result = await registerForSite(slug, {
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        accepted: data.get("accepted") === "on",
        answers,
      });
      setRegistered(result.noticeVersion);
      event.currentTarget.reset();
      setAnswers({});
    } catch (error) {
      // ERROR-INTENT: the anonymous form keeps the entered fields and renders the API refusal.
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

  return (
    /*
     * The portal's one point of difference is the organization's own colour, set here as
     * `--accent`; public-pages.css derives the hover shade and the tint from it on this same
     * element. The `theme-${site.theme}` class it also carried matched no rule in any
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
              <div className="pub-form-field">
                <label htmlFor="portal-name">
                  Name
                  <span className="pub-req" aria-hidden="true">
                    Required
                  </span>
                </label>
                <input className="control" id="portal-name" name="name" required maxLength={160} />
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
                />
              </div>
              {site.registrationFields.map((field) => {
                const id = `portal-${field.key}`;
                const value = answers[field.key] ?? "";
                const answer = (next: string) =>
                  setAnswers((current) => ({ ...current, [field.key]: next }));
                return (
                  <div className="pub-form-field" key={field.key}>
                    {field.kind === "select" ? (
                      <Select
                        id={id}
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
                          onChange={(change) => answer(change.target.value)}
                        />
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
                    <input name="accepted" type="checkbox" required />
                    <span>I accept privacy notice version {site.privacyNotice.version}.</span>
                  </label>
                </div>
              ) : null}
              <div className="pub-form-actions">
                <button className="primary" type="submit" disabled={busy || !site.privacyNotice}>
                  {busy ? "Registering…" : "Register"}
                </button>
              </div>
              {registrationError ? (
                <p className="pub-notice is-error" role="alert">
                  {registrationError}
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
