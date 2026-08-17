/**
 * The embeds this event has issued, and what an organizer can do about them.
 *
 * The panel exists because of one word in issue #192's residual epic: *withdraw*. The embed
 * sections above it compose a URL to copy, and that URL used to be unaccountable — nobody could
 * list what had been issued, and nothing but unpublishing the whole event could stop one. This
 * lists them and stops them one at a time.
 *
 * Three controls are shaped by what the API refuses rather than by what looks tidy.
 *
 * **Output is not editable** — it is shown as text with a Duplicate button beside it, because a
 * host page parsing JSON does not survive being handed HTML and the organizer cannot know who is
 * parsing.
 *
 * **The URL is shown once**, on the response that issued it, because only the digest is stored.
 * So it is shown in the row it belongs to, with a copy button, and nothing else on this panel
 * will issue a second address until this one has been acknowledged: duplicating an embed used to
 * replace the address on screen with the new one, destroying an address that existed nowhere else.
 *
 * **Withdrawing is permanent for that address.** Every host page still pointing at it starts
 * getting a 404, so the press asks first and names the embed it is about to stop.
 *
 * @spec PRD-PUB-001
 */
import { type FormEvent, useCallback, useState } from "react";
import { describeApiFailure } from "../api/config";
import {
  createEmbed,
  duplicateEmbed,
  type EmbedsResponse,
  listEmbeds,
  revokeEmbed,
} from "../api/embeds";
import { CopyableSecret, Field, Select } from "../ui/fields";
import { IconGlobe } from "../ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  LoadFailure,
  Notice,
  Pill,
  Section,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "../ui/primitives";
import { EMBED_VIEW_LABELS } from "../ui/vocabulary";

const describe = (reason: unknown) =>
  describeApiFailure(reason, "The embed service did not answer.").message;

const OUTPUTS = [
  { id: "styled-html", label: "Styled HTML page" },
  { id: "basic-html", label: "Unstyled HTML fragment" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "ical", label: "iCalendar" },
] as const;

/*
 * The views an embed may be issued as, read from the shared vocabulary rather than from a copy
 * kept here. The copy that used to live in this file had drifted from the one the embed sections
 * above render, and `EMBED_VIEW_LABELS` is keyed by the contract's own enum, so it cannot.
 *
 * The Sessions view is deliberately absent: `embedViewSchema` does not admit it, so it can be
 * copied as a URL upstairs and never issued as a named, withdrawable address. The hint under the
 * picker says so rather than leaving the reader to notice the gap.
 */
const VIEW_OPTIONS = Object.entries(EMBED_VIEW_LABELS).map(([value, label]) => ({ value, label }));

/** The address a newly issued embed answers at, which exists on screen exactly once. */
type Issued = { embedId: string; name: string; url: string };

export function SavedEmbeds({ eventId, canManage }: { eventId: string; canManage: boolean }) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [name, setName] = useState("");
  const [view, setView] = useState<string>("schedule");
  const [output, setOutput] = useState<string>("styled-html");
  /** The embed a Withdraw press is asking about, and the name the confirmation says back. */
  const [withdrawing, setWithdrawing] = useState<{ id: string; name: string } | null>(null);

  const embeds = useLoad<string, EmbedsResponse>(
    eventId,
    useCallback((id: string) => listEmbeds(id), []),
    describe,
  );

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await embeds.reload();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  async function issue(formEvent: FormEvent) {
    formEvent.preventDefault();
    await run("Embed issued.", async () => {
      const created = await createEmbed(eventId, { name, view, output });
      setIssued({ embedId: created.embed.id, name: created.embed.name, url: created.url });
      setName("");
    });
  }

  if (embeds.error)
    return <LoadFailure what="the issued embeds" error={embeds.error} onRetry={embeds.reload} />;
  if (!embeds.data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading the issued embeds" />
      </Card>
    );
  const list = embeds.data.embeds;
  /* An unacknowledged address blocks the two controls that would replace it on screen. */
  const holding = issued !== null;

  return (
    <Section
      labelledBy="publishing-issued"
      title="Issued embeds"
      description="A named address you can withdraw. Withdrawing one leaves every other embed working."
    >
      {feedback}

      {list.length === 0 ? (
        /*
         * An empty list is an invitation to act, so the form below is the invitation and this is
         * one line of context above it. It used to be a 48px-padded centred empty state with a
         * glyph, stacked on top of the form that answers it: two answers to "there is nothing
         * here", the taller of which could do nothing about it. Somebody who cannot issue one
         * still gets the empty state, because for them the form is not on the page.
         */
        canManage ? (
          /* `publishing-sub`, not `hint`: `.hint` is only declared inside `.field`, so a hint
             standing on its own renders as body copy at full ink. */
          <p className="publishing-sub">
            Nothing has been issued yet. The embed sections above compose a URL to copy; naming one
            here is what gives it an address you can withdraw.
          </p>
        ) : (
          <EmptyState icon={<IconGlobe size={20} />} title="Nothing issued yet">
            The embed sections above compose a URL to copy. Issuing one here gives it a name you can
            find later and an address you can stop — which your role on this event cannot do.
          </EmptyState>
        )
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Embeds issued on this event</caption>
            <thead>
              <tr>
                <th scope="col">Embed</th>
                <th scope="col">Output</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((embed) => (
                <tr key={embed.id}>
                  <td className="primary-cell" data-label="Embed">
                    {embed.name}
                    <span className="sub">{EMBED_VIEW_LABELS[embed.view] ?? embed.view}</span>
                    {/* Shown once, in the row that produced it: only the digest is stored, so
                        this is the only moment the address exists anywhere on a screen. */}
                    {issued?.embedId === embed.id ? (
                      <Notice
                        tone="info"
                        role="status"
                        title="This address is shown once"
                        onDismiss={() => setIssued(null)}
                        dismissLabel="I have copied the address"
                      >
                        <CopyableSecret
                          label={`${embed.name} address`}
                          value={issued.url}
                          hint="Only its digest is stored. Nothing can show it again — issue a new embed instead."
                        />
                      </Notice>
                    ) : null}
                  </td>
                  <td data-label="Output">
                    {/* Text rather than a control: an issued output is what its consumers parse. */}
                    {OUTPUTS.find((entry) => entry.id === embed.output)?.label ?? embed.output}
                  </td>
                  <td data-label="State">
                    {embed.revokedAt ? (
                      <Pill tone="neutral">
                        Withdrawn {new Date(embed.revokedAt).toLocaleDateString()}
                      </Pill>
                    ) : (
                      <Pill tone="ok">Live</Pill>
                    )}
                  </td>
                  <td data-label="Actions" className="member-actions">
                    {canManage ? (
                      <>
                        <button
                          className="secondary small"
                          type="button"
                          disabled={busy || holding}
                          onClick={() =>
                            run(`Duplicated ${embed.name}.`, async () => {
                              const copy = await duplicateEmbed(eventId, embed.id, {
                                name: `${embed.name} (copy)`,
                              });
                              setIssued({
                                embedId: copy.embed.id,
                                name: copy.embed.name,
                                url: copy.url,
                              });
                            })
                          }
                        >
                          Duplicate
                          <span className="visually-hidden"> {embed.name}</span>
                        </button>
                        {embed.revokedAt ? null : (
                          <button
                            className="danger small member-remove"
                            type="button"
                            disabled={busy}
                            onClick={() => setWithdrawing({ id: embed.id, name: embed.name })}
                          >
                            Withdraw
                            <span className="visually-hidden"> {embed.name}</span>
                          </button>
                        )}
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage ? (
        <form className="publishing-issue-form" onSubmit={issue}>
          <Field label="Name" id="embed-name" required>
            {(control) => (
              <input
                {...control}
                className="control"
                maxLength={120}
                value={name}
                onChange={(changed) => setName(changed.target.value)}
              />
            )}
          </Field>
          <Select
            label="View"
            value={view}
            onChange={setView}
            options={VIEW_OPTIONS}
            hint="The Sessions view can be copied as a URL above, but cannot be issued as a named address yet."
          />
          <Select
            label="Output"
            value={output}
            onChange={setOutput}
            options={OUTPUTS.map((entry) => ({ value: entry.id, label: entry.label }))}
            hint="The output cannot change once the embed is issued — a host page parsing JSON does not survive being handed HTML. Duplicate it to make a different one."
          />
          <div className="toolbar">
            <button className="primary" type="submit" disabled={busy || holding || !name.trim()}>
              Issue embed
            </button>
            {holding ? (
              <p className="publishing-sub">
                Copy {issued.name}'s address above first — issuing another would replace it on
                screen, and it exists nowhere else.
              </p>
            ) : null}
          </div>
        </form>
      ) : null}

      <Drawer
        open={withdrawing !== null}
        title={withdrawing ? `Withdraw ${withdrawing.name}?` : "Withdraw this embed"}
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
                if (!target) return;
                setWithdrawing(null);
                // ERROR-INTENT: handlers cannot await; `run` announces both outcomes.
                void run(`Withdrew ${target.name}.`, () => revokeEmbed(eventId, target.id));
              }}
            >
              Withdraw it
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
          Its address starts answering as an unknown one immediately, so every host page still
          embedding it shows nothing. The address cannot be reissued — a replacement embed gets a
          new one, which every host page has to be given. Every other embed keeps working.
        </p>
      </Drawer>
    </Section>
  );
}
