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
 * One portal is one object, so editing it happens in a drawer rather than in five cards appended
 * to the list it was opened from: the list stays where the reader left it, the browser moves
 * focus into the thing being edited, and Escape puts it back.
 *
 * @spec PRD-PUB-002
 */
import { type FormEvent, useCallback, useState } from "react";
import { describeApiFailure } from "./api/config";
import {
  createSite,
  getSite,
  listSiteConsents,
  listSites,
  publishPrivacyNotice,
  setSiteState,
  type SiteConsents,
  type SiteDetail,
  type SitesResponse,
  updateSite,
} from "./api/sites";
import "./styles/identity.css";
import { Field, Select } from "./ui/fields";
import { IconForm, IconGlobe, IconSpeakers } from "./ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  GutterList,
  GutterRow,
  LoadFailure,
  Notice,
  Pill,
  Section,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "./ui/primitives";
import { SITE_STATE_TERMS } from "./ui/vocabulary";

const describe = (reason: unknown) =>
  describeApiFailure(reason, "The portal service did not answer.").message;

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
  /** Fetched on request rather than with the portal: the record is a list of people's addresses. */
  const [consents, setConsents] = useState<SiteConsents | null>(null);
  /** The portal a Take-down press is asking about, and the address that stops resolving. */
  const [withdrawing, setWithdrawing] = useState<{ id: string; slug: string; name: string } | null>(
    null,
  );

  const sites = useLoad<string, SitesResponse>(
    organizationId,
    useCallback((id: string) => listSites(id), []),
    describe,
  );

  const close = () => {
    setDraft(null);
    setDetail(null);
    setSelected(null);
    setConsents(null);
    setNotice("");
  };

  const open = async (siteId: string) => {
    setBusy(true);
    try {
      const found = await getSite(organizationId, siteId);
      setSelected(siteId);
      setDetail(found);
      // Another portal's consent record must not survive the switch, even for a frame.
      setConsents(null);
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

  if (sites.error)
    return <LoadFailure what="the portals" error={sites.error} onRetry={sites.reload} />;
  const data = sites.data;
  if (!data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading the portals" />
      </Card>
    );

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

      <Section
        labelledBy="portals-list"
        // Not "Portals" again: the page heading above already says that word, and a region
        // heading that repeats its page adds a line and no information. Naming the scope is the
        // one fact the page title does not carry — this list is the organization's, not this
        // event's.
        title="Portals in this organization"
        description="A portal lists open programs at one readable address."
        actions={
          canManage ? (
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setDetail(null);
                setConsents(null);
                setDraft(blankDraft);
              }}
            >
              New portal
            </button>
          ) : null
        }
      >
        {data.sites.length === 0 ? (
          <EmptyState icon={<IconGlobe size={20} />} title="No portals yet">
            A portal composes several programs — a call for proposals, an interest form, a speaker
            portal — behind one address and one privacy notice.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
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
                {data.sites.map((site) => {
                  const term = SITE_STATE_TERMS[site.state];
                  return (
                    <tr key={site.id} aria-selected={site.id === selected ? true : undefined}>
                      <td className="primary-cell" data-label="Portal">
                        {site.name}
                        {site.tagline ? <span className="sub">{site.tagline}</span> : null}
                      </td>
                      <td data-label="Address">
                        <code className="figure">/sites/{site.slug}</code>
                      </td>
                      <td data-label="State">
                        <Pill tone={term.tone}>{term.label}</Pill>
                      </td>
                      <td data-label="Actions">
                        <button
                          className="secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => open(site.id)}
                        >
                          Open
                          <span className="visually-hidden"> {site.name}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Drawer
        open={draft !== null}
        title={detail ? detail.site.name : "New portal"}
        description={
          detail
            ? `Everything this portal says and does, at /sites/${detail.site.slug}.`
            : "One address, one privacy notice, and the programs it lists."
        }
        busy={busy}
        onClose={close}
      >
        {draft ? (
          <div className="stack">
            <form className="stack" onSubmit={submitDraft}>
              <Field label="Name" id="portal-name" required>
                {(control) => (
                  <input
                    {...control}
                    className="control"
                    maxLength={120}
                    value={draft.name}
                    onChange={(changed) => setDraft({ ...draft, name: changed.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Public address"
                id="portal-slug"
                required
                hint={`Visitors reach it at /sites/${draft.slug || "…"}`}
              >
                {(control) => (
                  <input
                    {...control}
                    className="control"
                    maxLength={120}
                    value={draft.slug}
                    onChange={(changed) => setDraft({ ...draft, slug: changed.target.value })}
                  />
                )}
              </Field>
              <Field label="Tagline" id="portal-tagline">
                {(control) => (
                  <input
                    {...control}
                    className="control"
                    maxLength={200}
                    value={draft.tagline}
                    onChange={(changed) => setDraft({ ...draft, tagline: changed.target.value })}
                  />
                )}
              </Field>
              <Field label="Landing heading" id="portal-landing-heading">
                {(control) => (
                  <input
                    {...control}
                    className="control"
                    maxLength={160}
                    value={draft.landingHeading}
                    onChange={(changed) =>
                      setDraft({ ...draft, landingHeading: changed.target.value })
                    }
                  />
                )}
              </Field>
              <Field label="Landing text" id="portal-landing-body">
                {(control) => (
                  <textarea
                    {...control}
                    className="control"
                    maxLength={2000}
                    rows={4}
                    value={draft.landingBody}
                    onChange={(changed) =>
                      setDraft({ ...draft, landingBody: changed.target.value })
                    }
                  />
                )}
              </Field>
              <Field label="Sign-in heading" id="portal-login-heading">
                {(control) => (
                  <input
                    {...control}
                    className="control"
                    maxLength={160}
                    value={draft.loginHeading}
                    onChange={(changed) =>
                      setDraft({ ...draft, loginHeading: changed.target.value })
                    }
                  />
                )}
              </Field>
              {/*
                The sign-in body was declared, initialised, sent on every save and read back from
                the server — and had no control anywhere, so every portal's sign-in page carried an
                empty paragraph nobody could fill in.
              */}
              <Field
                label="Sign-in text"
                id="portal-login-body"
                hint="Shown under the sign-in heading, where somebody is deciding whether to hand over an address."
              >
                {(control) => (
                  <textarea
                    {...control}
                    className="control"
                    maxLength={2000}
                    rows={3}
                    value={draft.loginBody}
                    onChange={(changed) => setDraft({ ...draft, loginBody: changed.target.value })}
                  />
                )}
              </Field>
              <Select
                label="Theme"
                value={draft.theme}
                onChange={(next) => setDraft({ ...draft, theme: next as DraftState["theme"] })}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "auto", label: "Follow the visitor's setting" },
                ]}
              />
              <Field label="Primary colour" id="portal-color" hint="A hex value, like #2f5d50.">
                {(control) => (
                  <input
                    {...control}
                    className="control figure"
                    value={draft.primaryColor}
                    pattern="#[0-9a-fA-F]{6}"
                    onChange={(changed) =>
                      setDraft({ ...draft, primaryColor: changed.target.value })
                    }
                  />
                )}
              </Field>
              <div className="toolbar">
                <button className="primary" type="submit" disabled={busy}>
                  {detail ? "Save portal" : "Create portal"}
                </button>
                <button className="secondary" type="button" disabled={busy} onClick={close}>
                  Cancel
                </button>
              </div>
            </form>

            {detail ? (
              <>
                <Section
                  level="h3"
                  labelledBy="portal-programs"
                  title="Programs"
                  description="Listed in the order shown. A program is a pointer; its own domain owns what it says."
                >
                  {detail.site.programs.length === 0 ? (
                    /* What is true, rather than an instruction to use a control that exists
                       nowhere in this console: nothing here attaches a program today. */
                    <EmptyState icon={<IconForm size={20} />} title="No programs listed">
                      This portal publishes its landing page, its pages and its registration form.
                      Listing a call for proposals, an interest form or a speaker portal alongside
                      them is done through the portal API — no control on this screen attaches one
                      yet.
                    </EmptyState>
                  ) : (
                    <ul className="plain-list">
                      {detail.site.programs.map((program) => {
                        const unresolved = detail.unresolvedPrograms.some(
                          (entry) => entry.kind === program.kind && entry.ref === program.ref,
                        );
                        return (
                          <li key={`${program.kind}:${program.ref}`}>
                            {program.label || program.ref}{" "}
                            <Pill tone="info">{PROGRAM_LABEL[program.kind] ?? program.kind}</Pill>
                            {unresolved ? (
                              <Pill tone="warn">
                                Not found — visitors see the label without a title
                              </Pill>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Section>

                <Section
                  level="h3"
                  labelledBy="portal-privacy"
                  title="Privacy notice"
                  description="Appended, never rewritten: every registration records the version it accepted."
                >
                  {detail.site.privacyNotice ? (
                    <p>
                      Version {detail.site.privacyNotice.version}, effective{" "}
                      {new Date(detail.site.privacyNotice.effectiveAt).toLocaleString()}.
                    </p>
                  ) : (
                    <Notice tone="warn" role="status">
                      Publish a privacy notice before the portal goes live. Registration records the
                      version somebody accepted, so a live portal without one would record consent
                      to nothing.
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
                      <Field label="New notice version" id="portal-notice" required>
                        {(control) => (
                          <textarea
                            {...control}
                            className="control"
                            rows={5}
                            value={notice}
                            onChange={(changed) => setNotice(changed.target.value)}
                          />
                        )}
                      </Field>
                      <div className="toolbar">
                        <button className="primary" type="submit" disabled={busy}>
                          Publish notice version
                        </button>
                      </div>
                    </form>
                  ) : null}
                </Section>

                {/*
                 * Who accepted which version, which is the only thing that makes an append-only
                 * notice worth having: a notice nobody can trace a consent back to proves nothing.
                 *
                 * Loaded on request rather than with the portal. Every row is a registrant's
                 * address, so opening the portal to change its tagline should not put a list of
                 * people's email addresses on the screen and into a screenshot.
                 */}
                <Section
                  level="h3"
                  labelledBy="portal-consents"
                  title="Consent record"
                  description="Each registration stores the notice version it accepted, and neither the notice nor the record can be rewritten."
                >
                  {consents === null ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          setConsents(await listSiteConsents(organizationId, detail.site.id));
                        } catch (reason) {
                          announce("error", describe(reason));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Show who consented
                    </button>
                  ) : consents.consents.length === 0 ? (
                    <EmptyState icon={<IconSpeakers size={20} />} title="Nobody has registered yet">
                      A consent appears here the first time somebody completes the registration
                      form.
                    </EmptyState>
                  ) : (
                    <div className="table-wrap">
                      <table className="data">
                        <caption className="visually-hidden">
                          Consents recorded on this portal
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Registrant</th>
                            <th scope="col">Notice version</th>
                            <th scope="col">Accepted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {consents.consents.map((entry) => (
                            <tr key={entry.id}>
                              <td className="primary-cell" data-label="Registrant">
                                {entry.actorRef}
                              </td>
                              <td data-label="Notice version">
                                <Pill
                                  tone={
                                    entry.noticeVersion === detail.site.privacyNotice?.version
                                      ? "ok"
                                      : "warn"
                                  }
                                >
                                  Version {entry.noticeVersion}
                                </Pill>
                              </td>
                              <td data-label="Accepted">
                                {new Date(entry.acceptedAt).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>

                {canManage ? (
                  <Section
                    level="h3"
                    labelledBy="portal-publication"
                    title="Publication"
                    description={`Revision ${detail.site.revision}. Publishing takes the current draft live.`}
                  >
                    <div className="toolbar">
                      <button
                        className="primary"
                        type="button"
                        disabled={busy || !detail.site.privacyNotice}
                        onClick={() =>
                          run("Portal published.", () =>
                            setSiteState(
                              organizationId,
                              detail.site.id,
                              "publish",
                              detail.site.revision,
                            ),
                          )
                        }
                      >
                        Publish
                      </button>
                      {/* Taking a portal down stops a public address resolving, so it is a
                          destructive control and it asks which address first. */}
                      <button
                        className="danger"
                        type="button"
                        disabled={busy || detail.site.state !== "published"}
                        onClick={() =>
                          setWithdrawing({
                            id: detail.site.id,
                            slug: detail.site.slug,
                            name: detail.site.name,
                          })
                        }
                      >
                        Unpublish
                      </button>
                    </div>
                    {detail.publications.length > 0 ? (
                      <GutterList label="Published versions">
                        {detail.publications.map((entry) => (
                          <GutterRow
                            key={entry.version}
                            measure={`v${entry.version}`}
                            measureLabel="Version"
                            title={new Date(entry.publishedAt).toLocaleString()}
                          />
                        ))}
                      </GutterList>
                    ) : null}
                  </Section>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={withdrawing !== null}
        title={withdrawing ? `Take ${withdrawing.name} down?` : "Take this portal down"}
        busy={busy}
        onClose={() => setWithdrawing(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const target = withdrawing;
                if (!target || !detail) return;
                setWithdrawing(null);
                // ERROR-INTENT: handlers cannot await; `run` announces both outcomes.
                void run("Portal withdrawn.", () =>
                  setSiteState(organizationId, target.id, "unpublish", detail.site.revision),
                );
              }}
            >
              Take it down
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setWithdrawing(null)}
            >
              Keep it live
            </button>
          </>
        }
      >
        <p>
          <code>/sites/{withdrawing?.slug}</code> stops resolving for everybody, including anybody
          part-way through registering. The consent record is kept, and publishing again brings the
          same address back.
        </p>
      </Drawer>
    </div>
  );
}
