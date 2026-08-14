import type {
  ContentComment,
  ContentRevision,
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerMessage,
  SpeakerProfile,
  SpeakerResource,
  SpeakerTask,
  SpeakerTaskTemplate,
} from "../../domain/content/content";

export interface AcceptedContent {
  session: ContentSession;
  speakers: readonly SpeakerProfile[];
  tasks: readonly SpeakerTask[];
  messages: readonly SpeakerMessage[];
}

/**
 * A revision the caller wants recorded, minus the two things only the store may decide.
 *
 * `revisionNumber` is absent because an application that reads the highest number and adds one
 * has already lost the race: two organizers editing the same speaker both compute the same
 * number, and `UNIQUE(entity_type, entity_id, revision_number)` refuses the second edit that
 * was otherwise perfectly valid. `snapshotJson` is absent because the state a revision claims
 * to preserve must be the state the row actually held immediately before the write — read by
 * the store, in the same operation, not by a caller that read it moments earlier.
 */
export interface ContentRevisionDraft {
  readonly id: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly restoredFromRevisionId?: string | undefined;
}

/**
 * The edit itself, applied to whatever the store finds when it takes the row.
 *
 * A function rather than a finished entity, because the store may have to re-read: an edit that
 * lost the race for a revision number is retried against the row as it is *now*, so the losing
 * organizer's change lands on top of the winner's instead of overwriting it from a stale copy.
 */
export type ContentEdit<T> = (current: T) => T;

/** The workflow columns a bulk import owns, all three required. See `updateProfileWorkflow`. */
export interface SpeakerWorkflowFields {
  readonly workflowStatus: NonNullable<SpeakerProfile["workflowStatus"]>;
  readonly logistics: NonNullable<SpeakerProfile["logistics"]>;
  readonly customFields: NonNullable<SpeakerProfile["customFields"]>;
}

export interface ContentRepository {
  findSessionByProposal(eventId: string, proposalId: string): Promise<ContentSession | null>;
  accept(content: AcceptedContent): Promise<void>;
  workspace(eventId: string, userId?: string): Promise<ContentWorkspace>;
  /**
   * Write a profile with no revision and no guard.
   *
   * No production path calls this, and none should: an organizer's or speaker's profile edit
   * goes through `reviseProfile`, a headshot through `updateProfilePhoto`, and an import
   * through `updateProfileWorkflow`. Each of those writes what it is actually changing, so
   * none of them can put a column back the way it read it. This survives for fixtures.
   */
  updateProfile(profile: SpeakerProfile): Promise<void>;
  /**
   * Replace the three fields a bulk import owns, and touch nothing else.
   *
   * Same reasoning as `updateProfilePhoto`. An import that wrote the whole row would carry a
   * name, bio and headshot from whenever it read the profile, so importing a logistics column
   * could revert an organizer's edit made while the import was running.
   *
   * All three are required, and each is a *replacement* rather than a patch — an omitted
   * `logistics` would be stored as `{}`, not left alone. They are required in the type for
   * exactly that reason: `SpeakerProfile` has all three optional, so a `Pick` of it would let a
   * caller pass one field and silently erase the other two.
   *
   * `false` when no row matched — the profile has gone since the import read it. What an import
   * does with that is decided at the call site in `ContentService.importSpeakers` and stated in
   * `PRD-SPK-001`: the row is refused and reported, never silently skipped and never fatal to
   * the rest of the batch.
   */
  updateProfileWorkflow(profileId: string, fields: SpeakerWorkflowFields): Promise<boolean>;
  /**
   * Point a profile at one of its uploads, or at none — and touch nothing else.
   *
   * Narrow on purpose. `updateProfile` rewrites every mutable column from whatever the caller
   * last read, so choosing a headshot through it would put a bio, a workflow status and a
   * logistics field back the way they were at that read, silently undoing an organizer's edit
   * that landed in between. A speaker choosing a picture should write the picture.
   *
   * `false` when no row matched — the profile has gone since the caller read it, so the choice
   * was recorded on nothing. A caller that reports the choice back to a person must refuse
   * rather than answer with the object it constructed.
   */
  updateProfilePhoto(profileId: string, assetId: string | null): Promise<boolean>;
  /**
   * Take the next portal-invitation occurrence for one profile, and answer the number it took.
   *
   * The number is allocated *inside* the write, never read and then written back. Two organizers
   * pressing Invite on the same speaker at the same moment both read `invitations_sent = 1` if
   * they are allowed to read it, both key their invitation on occurrence 2, and the second one
   * deduplicates into the first's delivery — so one organizer is told the speaker has already
   * been invited about a message they never asked to send. Incrementing in the statement and
   * returning what the row took gives each of them a number nobody else holds, which is the same
   * reason `revisionNumber` is absent from `ContentRevisionDraft` (`1408`, and `1311` before it).
   *
   * `null` when no row matched — the profile has gone since the caller read it — so a claim that
   * landed on nothing is refused rather than reported as invitation zero.
   */
  claimInvitationOccurrence(profileId: string): Promise<number | null>;
  /** `false` when no row matched — the task has gone since the caller read it. */
  updateTask(task: SpeakerTask): Promise<boolean>;
  /**
   * Write a session with no revision and no guard.
   *
   * No production path calls this, and none should: an organizer's session edit goes through
   * `reviseSession`, which records who changed what and refuses to write from a copy the row
   * has moved past. It survives because fixtures in other domains' suites build session state
   * with it. A new caller here is a caller that has bypassed attributed history.
   */
  updateSession(session: ContentSession): Promise<void>;
  /** Remove a withdrawn session. Its speaker, their tasks, and their uploads are untouched. */
  deleteSession(sessionId: string): Promise<void>;
  /** `false` when no row matched — the asset has gone since the caller read it. */
  updateAsset(asset: SpeakerAsset): Promise<boolean>;
  addAsset(asset: SpeakerAsset): Promise<void>;
  /**
   * Store an upload as the newest version of its logical deliverable.
   *
   * The group and the version number are the store's to allocate, not the caller's: computing
   * either from a prior read is a read-then-write that two concurrent uploads resolve
   * identically, and the loser then trips `speaker_assets_version_unique` with a 500 describing
   * a constraint for a request that had nothing wrong with it. The caller supplies the
   * *identity* — `logicalKey`, or an explicit `versionGroupId` — and the store answers with the
   * group and number the row actually took (`1406`).
   */
  replaceLatestAsset(
    asset: SpeakerAsset,
    /** An explicit continuation of a named chain, which overrides `logicalKey` lookup. */
    versionGroupId?: string,
  ): Promise<{ versionGroupId: string; versionNumber: number }>;
  deleteAsset(assetId: string): Promise<void>;
  /**
   * Has this speaker been given any work on this event yet?
   *
   * The question acceptance actually asks before deciding whether to write the onboarding
   * checklist. It used to be answered by reading the event's **whole** workspace — every
   * profile, session, task, asset, message, resource, comment and revision — and testing one
   * predicate over the tasks. That is nine tables read to learn one boolean, on the busiest
   * write in the product, and it is what issue #207 found first.
   *
   * Keyed off the work rather than off "did I just insert the profile", which is the property
   * that makes a retried acceptance assign the checklist once: the conversion port owns the
   * profile row, so a second attempt finds the profile already there either way.
   */
  hasSpeakerWork(eventId: string, profileId: string): Promise<boolean>;
  addTask(task: SpeakerTask): Promise<void>;
  addTasks(tasks: readonly SpeakerTask[]): Promise<void>;
  addMessage(message: SpeakerMessage): Promise<void>;
  findProfile(profileId: string): Promise<SpeakerProfile | null>;
  findSession(sessionId: string): Promise<ContentSession | null>;
  findAsset(assetId: string): Promise<SpeakerAsset | null>;
  findProfileBySource(eventId: string, sourcePersonId: string): Promise<SpeakerProfile | null>;
  addResource(resource: SpeakerResource): Promise<void>;
  /** `false` when no row matched — the resource has gone since the caller read it. */
  updateResource(resource: SpeakerResource): Promise<boolean>;
  deleteResource(resourceId: string): Promise<void>;
  findResource(resourceId: string): Promise<SpeakerResource | null>;
  /**
   * Write a resource at its `(event_id, slug)` identity rather than at its id.
   *
   * An import cannot know the destination's ids, and `speaker_resources` is
   * `UNIQUE(event_id, slug)`, so an insert is the one thing it must not do: the second
   * application of the same template would raise a unique violation instead of converging. The
   * store resolves the collision in one statement, which also makes two organizers applying the
   * same template at once land on one row rather than on an error.
   *
   * The `id` on a row that already exists is kept — a slug that already means something in this
   * event keeps its identity, so links and reads that already point at it stay pointing at it.
   */
  upsertResourceBySlug(resource: SpeakerResource): Promise<void>;
  /** Checklist lines an event has declared, in `sort_order`. */
  listTaskTemplates(eventId: string): Promise<readonly SpeakerTaskTemplate[]>;
  /** `upsertResourceBySlug` for a checklist line, whose identity is `(event_id, title)`. */
  upsertTaskTemplateByTitle(template: SpeakerTaskTemplate): Promise<void>;
  /**
   * One line by its own id, which is what the authoring surface edits and deletes.
   *
   * Deliberately separate from `upsertTaskTemplateByTitle`. That one converges a *clone* on the
   * title, which is a line's identity across events; this one addresses the row, which is the
   * only way to rename a line rather than leave the old title behind as a second one.
   */
  findTaskTemplate(templateId: string): Promise<SpeakerTaskTemplate | null>;
  addTaskTemplate(template: SpeakerTaskTemplate): Promise<void>;
  /**
   * `false` when no row matched, which the caller turns into the same refusal a line that does
   * not exist gets. A conditional write that matched nothing and one that landed are both a
   * successful statement; only the affected-row count separates them.
   */
  updateTaskTemplate(template: SpeakerTaskTemplate): Promise<boolean>;
  /**
   * Remove a line from the checklist. Tasks already assigned from it are untouched, because a
   * task is keyed by its title rather than by a pointer here: once assigned, the work is that
   * speaker's, and deleting a line an organizer no longer plans to give out must not delete
   * somebody's homework.
   */
  deleteTaskTemplate(templateId: string): Promise<void>;
  addComment(comment: ContentComment): Promise<void>;
  /**
   * Record what the profile was and write what it becomes, as one indivisible operation.
   *
   * There is deliberately no way to append a revision on its own. The two writes used to be
   * separate calls, so a failure on the second left a revision describing an edit that never
   * happened — history that reads as authoritative and is not. Returns the stored profile, or
   * `null` when the profile no longer exists.
   */
  reviseProfile(
    profileId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<SpeakerProfile>,
  ): Promise<SpeakerProfile | null>;
  /** `reviseProfile` for a session: the same single-operation guarantee. */
  reviseSession(
    sessionId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<ContentSession>,
  ): Promise<ContentSession | null>;
  findRevision(revisionId: string): Promise<ContentRevision | null>;
  findSpeakerImport(eventId: string, email: string): Promise<"pending" | "complete" | null>;
  beginSpeakerImport(eventId: string, email: string): Promise<void>;
  /**
   * Mark this event's import of one normalized address as finished.
   *
   * `false` when no row matched — the ledger row `beginSpeakerImport` wrote has gone since. The
   * import treats that exactly as it treats a profile that vanished: the row is refused and
   * reported rather than counted, because a row counted as imported that nothing recorded as
   * complete is a claim the store does not support. Refusing is safe in the same way the
   * `catch` around it is safe — the ledger is keyed on the address, so a retry converges.
   */
  completeSpeakerImport(eventId: string, email: string): Promise<boolean>;
}

export class ContentConflictError extends Error {}

/**
 * "Is this event's public page live?", answered by whoever owns publication state.
 *
 * Content asks because an asset an organizer marked publishable is reachable *through* that
 * page: taking the page down has to take its bytes down with it. The port is declared here so
 * the content domain never imports the publishing domain; the composition root supplies it.
 * An implementation is optional, and its absence means "nothing is published" — a missing
 * wiring loses public asset reads rather than silently serving withdrawn bytes.
 */
export interface EventPublicationQuery {
  isEventPublished(eventId: string): Promise<boolean>;
}

export interface AssetStoragePort {
  put(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<{ key: string }>;
  get(key: string): Promise<{ contentType: string; bytes: Uint8Array } | null>;
  delete(key: string): Promise<void>;
}
