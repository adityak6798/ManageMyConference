/**
 * Composing an organization's portal: its address, its branding, the programs it lists, its
 * pages, its registration form and the privacy notice registration records against.
 *
 * Three things on this screen exist because of how the API behaves rather than for looks.
 *
 * **Publish is refused until a privacy notice exists**, so the button says why before it is
 * pressed rather than after. Registration stores the notice version somebody accepted, and a live
 * portal with no notice would have to record consent to nothing.
 *
 * **A program whose source has gone is listed as unresolved**, not dropped. The API keeps it in
 * the visitor's order and names it here, because a portal that quietly shortened itself would
 * say nothing about why.
 *
 * **Every save carries the revision it read.** Two organizers editing the portal cannot
 * interleave into an arrangement neither of them chose; the second one is told to reload.
 *
 * @spec PRD-PUB-002
 */
import { type FormEvent, useCallback, useState } from "react";
import {
  createSite,
  getSite,
  listSites,
  publishPrivacyNotice,
  setSiteState,
  SiteApiError,
  type SiteDetail,
  type SitesResponse,
  updateSite,
} from "./api/sites";
import "./styles/identity.css";
import { Card, EmptyState, Notice, Pill, useActionFeedback, useLoad } from "./ui/primitives";

const describe = (reason: unknown) =>
  reason instanceof SiteApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

const PROGRAM_LABEL: Record<string, string> = {
  "event-cfp": "Call for proposals",
  "interest-form": "Interest form",
  "speaker-portal": "Speaker portal",
};

interface DraftState {
  slug: string;
  name: string;
  tagline: string;
  landingHeading: string;
  landingBody: string;
  loginHeading: string;
  loginBody: string;
  theme: "light" | "dark" | "auto";
  primaryColor: string;
}

const blankDraft: DraftState = {
  slug: "",
  name: "",
  tagline: "",
  landingHeading: "",
  landingBody: "",
  loginHeading: "",
  loginBody: "",
  theme: "light",
  primaryColor: "#2f5d50",
};

export function SitesWorkspace({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [notice, setNotice] = useState("");

  const sites = useLoad<string, SitesResponse>(
    organizationId,
    useCallback((id: string) => listSites(id), []),
    describe,
  );

  const open = async (siteId: string) => {
    setBusy(true);
    try {
      const found = await getSite(organizationId, siteId);
      setSelected(siteId);
      setDetail(found);
      setDraft({
        slug: found.site.slug,
        name: found.site.name,
        tagline: found.site.tagline,
        landingHeading: found.site.landingHeading,
        landingBody: found.site.landingBody,
        loginHeading: found.site.loginHeading,
        loginBody: found.site.loginBody,
        theme: found.site.theme,
        primaryColor: found.site.primaryColor,
      });
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await sites.reload();
      if (selected) {
        const refreshed = await getSite(organizationId, selected);
        setDetail(refreshed);
      }
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  if (sites.loading && !sites.data) return <Card>Loading sites…</Card>;
  if (sites.error) return <Notice tone="error">{sites.error}</Notice>;
  const data = sites.data;
  if (!data) return <Card>Loading sites…</Card>;

  async function submitDraft(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!draft) return;
    if (!detail) {
      await run("Site created.", async () => {
        const created = await createSite(organizationId, draft);
        await open(created.site.id);
      });
      return;
    }
    await run("Site saved.", () =>
      updateSite(organizationId, detail.site.id, {
        ...draft,
        expectedRevision: detail.site.revision,
        // The child collections are resent as they stand, because a save rewrites them: omitting
        // them would be read as "the organizer removed every page", not as "leave them alone".
        programs: detail.site.programs.map(({ kind, ref, label }) => ({ kind, ref, label })),
        pages: detail.site.pages.map(({ slug, title, bodyHtml, visibility }) => ({
          slug,
          title,
          bodyHtml,
          visibility,
        })),
        registrationFields: detail.site.registrationFields.map(
          ({ key, label, kind, required, options }) => ({ key, label, kind, required, options }),
        ),
      }),
    );
  }

  return (
    <div className="members">
      {feedback}

      <Card
        title="Portals"
        hint="A portal lists this organization's open programs at one readable address."
        actions={
          canManage ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setDetail(null);
                setDraft(blankDraft);
              }}
            >
              New portal
            </button>
          ) : null
        }
      >
        {data.sites.length === 0 ? (
          <EmptyState title="No portals yet">
            A portal composes several programs — a call for proposals, an interest form, a speaker
            portal — behind one address and one privacy notice.
          </EmptyState>
        ) : (
          <table>
            <caption className="visually-hidden">Portals in this organization</caption>
            <thead>
              <tr>
                <th scope="col">Portal</th>
                <th scope="col">Address</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((site) => (
                <tr key={site.id}>
                  <td className="primary-cell" data-label="Portal">
                    {site.name}
                    {site.tagline ? <span className="sub">{site.tagline}</span> : null}
                  </td>
                  <td data-label="Address">
                    <code>/sites/{site.slug}</code>
                  </td>
                  <td data-label="State">
                    <Pill tone={site.state === "published" ? "ok" : "neutral"}>{site.state}</Pill>
                  </td>
                  <td data-label="Actions">
                    <button type="button" disabled={busy} onClick={() => open(site.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {draft ? (
        <Card title={detail ? `Edit ${detail.site.name}` : "New portal"}>
          <form className="stack" onSubmit={submitDraft}>
            <label>
              Name
              <input
                required
                maxLength={120}
                value={draft.name}
                onChange={(changed) => setDraft({ ...draft, name: changed.target.value })}
              />
            </label>
            <label>
              Public address
              <input
                required
                maxLength={120}
                value={draft.slug}
                onChange={(changed) => setDraft({ ...draft, slug: changed.target.value })}
              />
            </label>
            <label>
              Tagline
              <input
                maxLength={200}
                value={draft.tagline}
                onChange={(changed) => setDraft({ ...draft, tagline: changed.target.value })}
              />
            </label>
            <label>
              Landing heading
              <input
                maxLength={160}
                value={draft.landingHeading}
                onChange={(changed) => setDraft({ ...draft, landingHeading: changed.target.value })}
              />
            </label>
            <label>
              Landing text
              <textarea
                maxLength={2000}
                rows={4}
                value={draft.landingBody}
                onChange={(changed) => setDraft({ ...draft, landingBody: changed.target.value })}
              />
            </label>
            <label>
              Sign-in heading
              <input
                maxLength={160}
                value={draft.loginHeading}
                onChange={(changed) => setDraft({ ...draft, loginHeading: changed.target.value })}
              />
            </label>
            <label>
              Theme
              <select
                value={draft.theme}
                onChange={(changed) =>
                  setDraft({ ...draft, theme: changed.target.value as DraftState["theme"] })
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="auto">Follow the visitor's setting</option>
              </select>
            </label>
            <label>
              Primary colour
              <input
                value={draft.primaryColor}
                pattern="#[0-9a-fA-F]{6}"
                onChange={(changed) => setDraft({ ...draft, primaryColor: changed.target.value })}
              />
            </label>
            <div className="actions">
              <button type="submit" disabled={busy}>
                {detail ? "Save portal" : "Create portal"}
              </button>
              <button type="button" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      ) : null}

      {detail ? (
        <>
          <Card
            title="Programs"
            hint="Listed in the order shown. A program is a pointer; its own domain owns what it says."
          >
            {detail.site.programs.length === 0 ? (
              <EmptyState title="No programs attached">
                Attach a call for proposals, an interest form or a speaker portal so visitors have
                somewhere to go.
              </EmptyState>
            ) : (
              <ul>
                {detail.site.programs.map((program) => {
                  const unresolved = detail.unresolvedPrograms.some(
                    (entry) => entry.kind === program.kind && entry.ref === program.ref,
                  );
                  return (
                    <li key={`${program.kind}:${program.ref}`}>
                      {program.label || program.ref}{" "}
                      <Pill tone="info">{PROGRAM_LABEL[program.kind] ?? program.kind}</Pill>
                      {unresolved ? (
                        <Pill tone="warn">Not found — visitors see the label without a title</Pill>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            title="Privacy notice"
            hint="Appended, never rewritten: every registration records the version it accepted."
          >
            {detail.site.privacyNotice ? (
              <p>
                Version {detail.site.privacyNotice.version}, effective{" "}
                {new Date(detail.site.privacyNotice.effectiveAt).toLocaleString()}.
              </p>
            ) : (
              <Notice tone="warn">
                Publish a privacy notice before the portal goes live. Registration records the
                version somebody accepted, so a live portal without one would record consent to
                nothing.
              </Notice>
            )}
            {canManage ? (
              <form
                className="stack"
                onSubmit={(formEvent) => {
                  formEvent.preventDefault();
                  const text = notice;
                  setNotice("");
                  // ERROR-INTENT: `run` reports its own failure through `announce` and never
                  // rejects, so awaiting it here would only delay the handler's return.
                  void run("Privacy notice published.", () =>
                    publishPrivacyNotice(organizationId, detail.site.id, text),
                  );
                }}
              >
                <label>
                  New notice version
                  <textarea
                    rows={5}
                    required
                    value={notice}
                    onChange={(changed) => setNotice(changed.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Publish notice version
                </button>
              </form>
            ) : null}
          </Card>

          {canManage ? (
            <Card title="Publication" hint={`Revision ${detail.site.revision}.`}>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || !detail.site.privacyNotice}
                  onClick={() =>
                    run("Portal published.", () =>
                      setSiteState(organizationId, detail.site.id, "publish", detail.site.revision),
                    )
                  }
                >
                  Publish
                </button>
                <button
                  type="button"
                  disabled={busy || detail.site.state !== "published"}
                  onClick={() =>
                    run("Portal withdrawn.", () =>
                      setSiteState(
                        organizationId,
                        detail.site.id,
                        "unpublish",
                        detail.site.revision,
                      ),
                    )
                  }
                >
                  Unpublish
                </button>
              </div>
              {detail.publications.length > 0 ? (
                <ul>
                  {detail.publications.map((entry) => (
                    <li key={entry.version}>
                      Version {entry.version} · {new Date(entry.publishedAt).toLocaleString()}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
