/**
 * The embed lifecycle: naming one, changing it, duplicating it, withdrawing it, and serving it.
 *
 * Issue #192's residual epic. Four properties are worth stating before the code.
 *
 * **Withdrawal is the point.** Before this, an embed URL pasted into somebody else's site kept
 * answering for ever and the only way to stop it was to unpublish the whole event. `revoke` makes
 * one embed stop without touching the others, and the row survives so the organizer can see what
 * they issued and when they ended it.
 *
 * **An embed cannot outlive the publication it renders.** Resolving reads the *published*
 * projection through the same snapshot every other public surface reads, so unpublishing an event
 * silences every embed on it in the same instant — and a revoked embed and an unpublished event
 * answer identically, so neither can be used to probe the other.
 *
 * **The output type is immutable, and so is the address.** A host page parsing JSON does not
 * survive being handed HTML, and an organizer editing an embed cannot know who is parsing it.
 * Changing either is `duplicate`, which mints a new token and leaves the old integration working
 * until its owner takes it down. Migration `1805` enforces both with triggers, so a future writer
 * that skipped this service still cannot do it.
 *
 * **Presentation is bounded and validated twice.** The accent is matched against a six-digit hex
 * pattern here and again by the table's `CHECK`, which is what makes interpolating it into the
 * embed's inline stylesheet safe rather than an injection point.
 *
 * @spec PRD-PUB-001 ARC-DOM-001
 */
import {
  EMBED_FIELDS,
  EMBED_OUTPUTS,
  EMBED_VIEWS,
  type EmbedFilters,
  type EmbedOutput,
  type EmbedTheme,
  type EmbedView,
  isEmbedAccent,
  type PublicationEmbed,
  type RenderedEmbed,
  renderEmbed,
} from "../../domain/publishing/embed";
import { composePublicSchedule } from "../../domain/publishing/publication";
import { type Actor, requireEventCapability } from "../identity/actor";
import type { PublicationRepository } from "./publication-repository";

export class EmbedNotFoundError extends Error {}
export class EmbedInvalidError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
export class EmbedConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("This embed changed while you were editing it. Reload and reapply your changes.");
  }
}

export interface EmbedDraft {
  readonly name: string;
  readonly view: string;
  readonly output: string;
  readonly accent?: string | undefined;
  readonly theme?: string | undefined;
  readonly filters?: EmbedFilters | undefined;
  readonly fields?: readonly string[] | undefined;
}

export interface EmbedRepository {
  list(eventId: string): Promise<readonly PublicationEmbed[]>;
  find(eventId: string, embedId: string): Promise<PublicationEmbed | null>;
  /** By digest, and only while live: a withdrawn embed is not found rather than forbidden. */
  findLiveByTokenHash(tokenHash: string): Promise<PublicationEmbed | null>;
  create(embed: PublicationEmbed, tokenHash: string): Promise<void>;
  /** Everything except `output` and the token, which migration `1805` refuses to move. */
  update(embed: PublicationEmbed, expectedRevision: number): Promise<number>;
  revoke(eventId: string, embedId: string, at: string): Promise<number>;
}

export interface EmbedDependencies {
  repository: EmbedRepository;
  publications: Pick<PublicationRepository, "findByEventId" | "findPublicBySlug">;
  /** The agenda publication in force, for the schedule the embed renders. */
  schedule(eventId: string): Promise<{ version: number; publishedAt: string } | null>;
  mintToken(): Promise<{ token: string; tokenHash: string }>;
  hash(value: string): Promise<string>;
  /** Where an embed is reachable, so no client assembles the URL. */
  embedBaseUrl: string;
  newId(): string;
  now(): Date;
}

const MAX_FILTER_VALUE = 120;

export class EmbedService {
  constructor(private readonly dependencies: EmbedDependencies) {}

  private authorize(actor: Actor | null, eventId: string): Actor {
    // The same capability publishing the page takes: an embed is a public surface, and issuing
    // one is a publication decision rather than a settings read.
    return requireEventCapability(actor, eventId, "events:settings:update");
  }

  private validate(draft: EmbedDraft, existing?: PublicationEmbed) {
    const fields: Record<string, string[]> = {};
    const name = draft.name.trim();
    if (name.length < 1 || name.length > 120)
      fields.name = ["An embed name is 1 to 120 characters."];
    if (!EMBED_VIEWS.includes(draft.view as EmbedView))
      fields.view = ["Choose one of the offered views."];
    if (!EMBED_OUTPUTS.includes(draft.output as EmbedOutput))
      fields.output = ["Choose one of the offered outputs."];
    // The one edit this service refuses outright rather than validating: an existing embed's
    // output is what its consumers parse, and the message says what to do instead.
    if (existing && draft.output !== existing.output)
      fields.output = [
        "An embed's output cannot change once it is issued. Duplicate it to make a different one.",
      ];
    const accent = (draft.accent ?? existing?.accent ?? "#2f5d50").trim();
    if (!isEmbedAccent(accent)) fields.accent = ["Choose a six-digit hex colour, such as #2f5d50."];
    const theme = (draft.theme ?? existing?.theme ?? "light") as EmbedTheme;
    if (!["light", "dark", "auto"].includes(theme))
      fields.theme = ["Choose light, dark, or follow the visitor's setting."];
    const selected = [...new Set(draft.fields ?? [])].filter((field) =>
      EMBED_FIELDS.includes(field),
    );
    const unknown = (draft.fields ?? []).filter((field) => !EMBED_FIELDS.includes(field));
    if (unknown.length > 0)
      fields.fields = [`A session card has no field called ${unknown.join(", ")}.`];
    const filters: EmbedFilters = {
      ...(draft.filters?.track ? { track: draft.filters.track.slice(0, MAX_FILTER_VALUE) } : {}),
      ...(draft.filters?.format ? { format: draft.filters.format.slice(0, MAX_FILTER_VALUE) } : {}),
      ...(draft.filters?.day ? { day: draft.filters.day.slice(0, 10) } : {}),
    };
    if (filters.day && !/^\d{4}-\d{2}-\d{2}$/.test(filters.day))
      fields["filters.day"] = ["A day filter is a calendar date, such as 2026-08-14."];
    if (Object.keys(fields).length > 0)
      throw new EmbedInvalidError("Review the highlighted embed settings.", fields);
    return {
      name,
      view: draft.view as EmbedView,
      output: draft.output as EmbedOutput,
      accent,
      theme,
      filters,
      fields: selected,
    };
  }

  async list(actor: Actor | null, eventId: string) {
    this.authorize(actor, eventId);
    return this.dependencies.repository.list(eventId);
  }

  /**
   * Issue an embed. The URL is returned once, because only the digest is stored.
   *
   * That is the same rule the itinerary, the invitation and a report share link follow. An
   * organizer who loses the URL revokes the embed and issues another, which is also the honest
   * answer: an address they cannot produce is an address they cannot audit.
   */
  async create(
    actor: Actor | null,
    eventId: string,
    draft: EmbedDraft,
  ): Promise<{ embed: PublicationEmbed; url: string }> {
    const authorized = this.authorize(actor, eventId);
    const validated = this.validate(draft);
    const now = this.dependencies.now().toISOString();
    const { token, tokenHash } = await this.dependencies.mintToken();
    const embed: PublicationEmbed = {
      id: this.dependencies.newId(),
      eventId,
      ...validated,
      createdBy: authorized.id,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      revokedAt: null,
    };
    await this.dependencies.repository.create(embed, tokenHash);
    return { embed, url: this.urlFor(token) };
  }

  async update(
    actor: Actor | null,
    eventId: string,
    embedId: string,
    draft: EmbedDraft & { expectedRevision: number },
  ): Promise<PublicationEmbed> {
    this.authorize(actor, eventId);
    const existing = await this.dependencies.repository.find(eventId, embedId);
    if (!existing) throw new EmbedNotFoundError("That embed was not found");
    if (existing.revokedAt)
      throw new EmbedInvalidError("A withdrawn embed cannot be edited. Duplicate it instead.", {
        name: ["This embed has been withdrawn."],
      });
    if (existing.revision !== draft.expectedRevision)
      throw new EmbedConflictError(existing.revision);
    const next: PublicationEmbed = {
      ...existing,
      ...this.validate(draft, existing),
      updatedAt: this.dependencies.now().toISOString(),
      revision: existing.revision + 1,
    };
    if ((await this.dependencies.repository.update(next, draft.expectedRevision)) === 0)
      throw new EmbedConflictError(existing.revision);
    return next;
  }

  /**
   * Copy an embed under a new address.
   *
   * The one way to change an output type, and the reason it is a copy rather than an edit: the
   * old address keeps working, so whoever pasted it into their site is not broken by somebody
   * else's decision. They can be told to move at their own pace, and the old embed revoked when
   * they have.
   */
  async duplicate(
    actor: Actor | null,
    eventId: string,
    embedId: string,
    changes: { name: string; output?: string | undefined },
  ): Promise<{ embed: PublicationEmbed; url: string }> {
    this.authorize(actor, eventId);
    const existing = await this.dependencies.repository.find(eventId, embedId);
    if (!existing) throw new EmbedNotFoundError("That embed was not found");
    return this.create(actor, eventId, {
      name: changes.name,
      view: existing.view,
      output: changes.output ?? existing.output,
      accent: existing.accent,
      theme: existing.theme,
      filters: existing.filters,
      fields: existing.fields,
    });
  }

  /** Withdraw one embed. Idempotent: an already-withdrawn embed answers 0 rather than failing. */
  async revoke(actor: Actor | null, eventId: string, embedId: string): Promise<number> {
    this.authorize(actor, eventId);
    return this.dependencies.repository.revoke(
      eventId,
      embedId,
      this.dependencies.now().toISOString(),
    );
  }

  /**
   * Serve an embed to a host page, or answer null.
   *
   * A withdrawn embed, an unknown token, an unpublished event and one whose publication has been
   * taken down are one indistinguishable answer — the same rule the public event hub and the
   * itinerary follow, so none of these routes can be used to discover the others.
   */
  async resolve(token: string): Promise<RenderedEmbed | null> {
    const embed = await this.dependencies.repository.findLiveByTokenHash(
      await this.dependencies.hash(token),
    );
    if (!embed) return null;
    const publication = await this.dependencies.publications.findByEventId(embed.eventId);
    // The *published* snapshot, never the draft: an embed renders what visitors are being served,
    // and an organizer's unsaved edit is not a public fact.
    if (!publication || publication.state !== "published" || !publication.published) return null;
    const agenda = await this.dependencies.schedule(embed.eventId);
    const schedule = agenda ? composePublicSchedule(publication.published, agenda) : null;
    return renderEmbed(embed, publication.published, schedule);
  }

  /** Where an embed is reachable. One place, so no client assembles it. */
  urlFor(token: string): string {
    return `${this.dependencies.embedBaseUrl}/api/public/embeds/${token}`;
  }
}
