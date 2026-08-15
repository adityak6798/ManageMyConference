/** Anonymous organization portal and consent-stamped registration. @spec PRD-PUB-002 */
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import type { PublicSiteDto } from "@greenroom/contracts";
import { readPublicSite, readPublicSitePage, registerForSite } from "./api/sites";
import "./styles/public-pages.css";

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
      <main className="public-shell">
        <h1>Portal unavailable</h1>
        <p>This portal is not published or no longer exists.</p>
      </main>
    );
  if (page)
    return (
      <div className="public-shell">
        <header>
          <a href={`/sites/${page.site.slug}`}>{page.site.name}</a>
        </header>
        <main className="pub-section">
          <h1>{page.page.title}</h1>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: publishing sanitizes this HTML before storage and serves only the sanitized projection. */}
          <div dangerouslySetInnerHTML={{ __html: page.page.bodyHtml }} />
        </main>
        <footer>{page.site.name}</footer>
      </div>
    );
  if (!site)
    return (
      <main className="public-shell">
        <p>Loading portal…</p>
      </main>
    );

  return (
    <div
      className={`public-shell theme-${site.theme}`}
      style={{ "--accent": site.primaryColor } as CSSProperties}
    >
      <header>
        <strong>{site.name}</strong>
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
          {site.landing.body ? <p>{site.landing.body}</p> : null}
        </section>

        {site.programs.length > 0 ? (
          <section className="pub-section" aria-labelledby="portal-programs">
            <h2 id="portal-programs">Programs</h2>
            <ul>
              {site.programs.map((program) => (
                <li key={`${program.kind}:${program.ref}`}>
                  <a href={program.href}>{program.title ?? program.label}</a>
                  {program.state ? <span> · {program.state}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="pub-section" aria-labelledby="portal-register">
          <h2 id="portal-register">{site.login.heading || "Register"}</h2>
          {site.login.body ? <p>{site.login.body}</p> : null}
          {registered ? (
            <p role="status">Registered with privacy notice version {registered}.</p>
          ) : (
            <form className="stack" onSubmit={register}>
              <label>
                Name
                <input name="name" required maxLength={160} />
              </label>
              <label>
                Email
                <input name="email" type="email" required maxLength={254} />
              </label>
              {site.registrationFields.map((field) => {
                const id = `portal-${field.key}`;
                return (
                  <div className="field" key={field.key}>
                    <label htmlFor={id}>{field.label}</label>
                    {field.kind === "select" ? (
                      <select
                        id={id}
                        required={field.required}
                        value={answers[field.key] ?? ""}
                        onChange={(change) =>
                          setAnswers((current) => ({
                            ...current,
                            [field.key]: change.target.value,
                          }))
                        }
                      >
                        <option value="">Choose…</option>
                        {field.options.map((option) => (
                          <option key={option}>{option}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        required={field.required}
                        value={answers[field.key] ?? ""}
                        onChange={(change) =>
                          setAnswers((current) => ({
                            ...current,
                            [field.key]: change.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                );
              })}
              {site.privacyNotice ? (
                <>
                  <div
                    className="hint"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: publishing sanitizes this HTML before storage and versions that exact projection.
                    dangerouslySetInnerHTML={{ __html: site.privacyNotice.bodyHtml }}
                  />
                  <label>
                    <input name="accepted" type="checkbox" required /> I accept privacy notice
                    version {site.privacyNotice.version}.
                  </label>
                </>
              ) : null}
              <button type="submit" disabled={busy || !site.privacyNotice}>
                {busy ? "Registering…" : "Register"}
              </button>
              {registrationError ? <p role="alert">{registrationError}</p> : null}
            </form>
          )}
        </section>
      </main>
      <footer>{site.name}</footer>
    </div>
  );
}
