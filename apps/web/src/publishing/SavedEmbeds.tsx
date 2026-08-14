/**
 * The embeds this event has issued, and what an organizer can do about them.
 *
 * The panel exists because of one word in issue #192's residual epic: *withdraw*. The embed cards
 * above it compose a URL to copy, and that URL used to be unaccountable — nobody could list what
 * had been issued, and nothing but unpublishing the whole event could stop one. This lists them
 * and stops them one at a time.
 *
 * Two controls are deliberately shaped by what the API refuses rather than by what looks tidy.
 * **Output is not editable** — it is shown as text with a Duplicate button beside it, because a
 * host page parsing JSON does not survive being handed HTML and the organizer cannot know who is
 * parsing. And **the URL is shown once**, on the response that issued it, because only the digest
 * is stored: saying so at the moment it appears is the only place the warning helps.
 *
 * @spec PRD-PUB-001
 */
import { type FormEvent, useCallback, useState } from "react";
import {
  createEmbed,
  duplicateEmbed,
  EmbedApiError,
  type EmbedsResponse,
  listEmbeds,
  revokeEmbed,
} from "../api/embeds";
import { Card, EmptyState, Notice, Pill, useActionFeedback, useLoad } from "../ui/primitives";

const describe = (reason: unknown) =>
  reason instanceof EmbedApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

const OUTPUTS = [
  { id: "styled-html", label: "Styled HTML page" },
  { id: "basic-html", label: "Unstyled HTML fragment" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "ical", label: "iCalendar" },
] as const;

const VIEWS = [
  { id: "schedule", label: "Schedule" },
  { id: "speakers", label: "Speakers" },
  { id: "gallery", label: "Gallery" },
  { id: "itinerary", label: "Itinerary" },
] as const;

export function SavedEmbeds({ eventId, canManage }: { eventId: string; canManage: boolean }) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [view, setView] = useState<string>("schedule");
  const [output, setOutput] = useState<string>("styled-html");

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
      setIssuedUrl(created.url);
      setName("");
    });
  }

  if (embeds.loading && !embeds.data) return <Card title="Issued embeds">Loading…</Card>;
  if (embeds.error) return <Notice tone="error">{embeds.error}</Notice>;
  const issued = embeds.data?.embeds ?? [];

  return (
    <Card
      title="Issued embeds"
      hint="A named address you can withdraw. Withdrawing one leaves every other embed working."
    >
      {feedback}
      {issuedUrl ? (
        <Notice tone="info">
          This address is shown once — only its digest is stored: <code>{issuedUrl}</code>
        </Notice>
      ) : null}

      {issued.length === 0 ? (
        <EmptyState title="Nothing issued yet">
          The embed cards above compose a URL to copy. Issuing one here gives it a name you can find
          later and an address you can stop.
        </EmptyState>
      ) : (
        <table>
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
            {issued.map((embed) => (
              <tr key={embed.id}>
                <td className="primary-cell" data-label="Embed">
                  {embed.name}
                  <span className="sub">{embed.view}</span>
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
                <td data-label="Actions">
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(`Duplicated ${embed.name}.`, async () => {
                            const copy = await duplicateEmbed(eventId, embed.id, {
                              name: `${embed.name} (copy)`,
                            });
                            setIssuedUrl(copy.url);
                          })
                        }
                      >
                        Duplicate
                      </button>
                      {embed.revokedAt ? null : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(`Withdrew ${embed.name}.`, () => revokeEmbed(eventId, embed.id))
                          }
                        >
                          Withdraw
                        </button>
                      )}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage ? (
        <form className="stack" onSubmit={issue}>
          <label>
            Name
            <input
              required
              maxLength={120}
              value={name}
              onChange={(changed) => setName(changed.target.value)}
            />
          </label>
          <label>
            View
            <select value={view} onChange={(changed) => setView(changed.target.value)}>
              {VIEWS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Output
            <select value={output} onChange={(changed) => setOutput(changed.target.value)}>
              {OUTPUTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            The output cannot change once the embed is issued — a host page parsing JSON does not
            survive being handed HTML. Duplicate it to make a different one.
          </p>
          <button type="submit" disabled={busy || !name.trim()}>
            Issue embed
          </button>
        </form>
      ) : null}
    </Card>
  );
}
