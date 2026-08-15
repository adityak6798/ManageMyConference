/**
 * Self-serve signup: turning a verified provider identity into a working workspace.
 *
 * This is identity-access behaviour, not a transport concern, which is why it is a service with
 * ports rather than a block of code in the callback route. Three outcomes, and the middle one is
 * the one worth reading twice:
 *
 * - **A known provider account.** Signed in as that user, nothing provisioned.
 * - **A new provider account whose *verified* address already belongs to a Greenroom identity.**
 *   The provider account is *linked* to that identity and nothing is provisioned. A seeded
 *   speaker who signs in with Google is that speaker, with the speaker's access — not a new
 *   organizer with an empty organization beside their real one. Linking is on the verified
 *   address only: an unverified one is refused outright, because "I claim this address" is
 *   precisely the takeover primitive account linking must not accept.
 * - **Neither.** A user, an organization, a first event and the organizer role on it.
 *
 * **Ordering, and what a failure leaves behind.** The steps are not one transaction: the
 * organization and event rows belong to the events domain and are written through its service,
 * so no batch spans both. They are ordered so that every partial state is either harmless or
 * detectable:
 *
 *   1. the organization row — unreferenced if we stop here, and **discarded when we do**:
 *      `recoverFromFailedIdentity` removes it rather than leaving an orphan for a data-aware
 *      demo reset to refuse on forever (issues #164, `GAP-019`);
 *   2. the identity batch — user, address, provider link and membership commit together or not
 *      at all, so a half-made account cannot sign in;
 *   3. the first event and the organizer role on it, which commit together in one batch.
 *
 * A failure at (3) leaves a user holding an organization and no event at all, and
 * `completeWorkspace` provisions one on their next sign-in — but only while that organization is
 * still theirs alone and still has no events, because the same shape is what an organization-level
 * invitation and a revoked event role both leave behind.
 *
 * **Two callbacks at once are ordinary**, not exotic — a person with two tabs open produces
 * exactly that (issue #166) — and neither of the two states they could otherwise leave behind is
 * repairable by the product: nothing deletes an event, and nothing deletes an organization. Both
 * are therefore prevented by storage rather than by ordering, and each racer converges on the
 * same workspace: the identity batch's own uniqueness picks one winner, and the events domain's
 * provisioning key picks one first event.
 *
 * @spec PRD-IAM-001 PRD-EVT-001
 */
import type { Actor } from "./actor";
import type { GoogleIdentity, WorkspaceIntent } from "./google-oauth";

/**
 * The default timezone of a workspace nobody has configured yet.
 *
 * Not guessed from the browser: the sign-in that creates this is a server-side redirect from
 * Google, which carries no locale worth trusting, and a *wrong* timezone silently mis-renders
 * every session time on the agenda. UTC is the one value that is obviously a placeholder, and
 * the empty state says where to change it.
 */
export const DEFAULT_TIMEZONE = "UTC";
/**
 * The first event is created with a default name rather than asked for in the flow.
 *
 * The alternative — a "name your event" screen between Google's redirect and the workspace — puts
 * a form in front of somebody who has not yet seen the product and cannot yet tell what they are
 * naming. Renaming is already a shipped, tested, one-field affordance on `/settings`
 * (`events:settings:update`), and the workspace's empty states point at it. So the flow spends its
 * one screen showing the product rather than collecting a string that is trivially changed later.
 */
export const FIRST_EVENT_NAME = "Your first event";

export class UnverifiedProviderEmailError extends Error {}
export class ProvisioningFailedError extends Error {}

/** One failure's message, whatever it was thrown as. */
const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/** The identity writes signup performs. Implemented by `D1IdentityDirectory`. */
export interface SignupDirectory {
  findByProviderAccount(provider: "google", subject: string): Promise<Actor | null>;
  findByEmail(email: string): Promise<Actor | null>;
  findByUserId(userId: string): Promise<Actor | null>;
  linkProviderAccount(input: {
    provider: "google";
    subject: string;
    userId: string;
    linkedAt: number;
  }): Promise<void>;
  /** `INSERT OR IGNORE`, so a role a concurrent callback already granted is safe to repeat. */
  grantOrganizer(eventId: string, userId: string): Promise<void>;
  /**
   * Make an existing account an organizer of an organization, if it belongs to none.
   *
   * Only `completeWorkspace` calls it, and only for an account that holds no organization at all —
   * a submitter-door identity signing in through the organizer door.
   *
   * **The "if it belongs to none" is the contract, not a description of the caller.** It returns
   * `false` when the account already had a membership, and that answer is what arbitrates two
   * concurrent sign-ins: each racer created its own organization, and without a condition in the
   * statement both memberships would land and the person would end up holding two conferences
   * nothing can delete. The loser discards what it made.
   */
  joinOrganization(organizationId: string, userId: string): Promise<boolean>;
  /**
   * How many people belong to this organization.
   *
   * The half of "is this workspace mine" that the events domain cannot answer, because
   * `organization_memberships` is this domain's table. One member means the organization has
   * exactly the person signing in, which is what a signup's own organization looks like; anything
   * else is somebody's workspace that this person was merely added to. See `completeWorkspace`.
   */
  countOrganizationMembers(organizationId: string): Promise<number>;
  /**
   * User row, address, provider link and organization membership, in one batch. Together or not
   * at all: an account that can sign in but belongs to no organization is a dead end the user
   * cannot leave, and one that has a membership but no address cannot be reached by mail.
   */
  createSelfServeIdentity(input: {
    userId: string;
    name: string;
    email: string;
    provider: "google";
    subject: string;
    linkedAt: number;
    /**
     * The organization this account is a member of, or `null` for an account that is not being
     * given one.
     *
     * Null is the submitter door (see `signInWithGoogle`): the batch then writes a user, an
     * address and a provider link and **no membership**, which is a complete, usable identity —
     * it can hold proposals, receive their confirmations and read their decisions — that simply
     * belongs to no conference. Every other caller passes an id, and the batch is atomic either
     * way, because an account that can sign in and has half its rows is a dead end.
     */
    organizationId: string | null;
  }): Promise<void>;
}

/**
 * The events domain's side of provisioning, bound in the composition root to its public
 * application interface. Identity names what it needs; it never learns a table.
 */
export interface WorkspaceProvisioning {
  provisionOrganization(command: { name: string }): Promise<{ id: string }>;
  /**
   * The one event a new workspace starts with, **idempotent per person per organization**: two
   * concurrent signups for one account both call it and both receive the same event, because the
   * events domain declares the uniqueness and the loser adopts the winner's row (issue #164).
   */
  createFirstEvent(
    actor: Actor,
    command: { organizationId: string; name: string; timezone: string },
  ): Promise<{ id: string }>;
  /**
   * The events this organization already holds. Read only to tell a workspace nobody has been
   * given an event in from one that is already somebody's; a first event is provisioned into the
   * former and never the latter, and nothing here ever adopts an event that already exists.
   */
  eventsInOrganization(actor: Actor, organizationId: string): Promise<readonly { id: string }[]>;
  /**
   * Discard an organization this signup created and then could not use.
   *
   * Refuses if the organization became somebody's workspace in the meantime, so it can only
   * remove what this call abandoned. See the ordering note at the top of this file.
   */
  discardUnusedOrganization(organizationId: string): Promise<boolean>;
}

export interface SignupDependencies {
  directory: SignupDirectory;
  workspace: WorkspaceProvisioning;
  newId: () => string;
  now: () => number;
  /**
   * Where an operational fact this workflow cannot act on goes.
   *
   * One caller today: an organization a failed signup created and could **not** discard, because
   * something already referenced it. That row is invisible to the product — no member, no
   * surface, nothing that lists it — and it is precisely the row a data-aware demo restore
   * refuses on (`GAP-019`), so a silent one turns into a reset that refuses for ever with no
   * trace of where it came from. Optional, because a composition with no logger is a test.
   */
  report?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * What to call the organization of somebody who has not been asked.
 *
 * Their own name, which is true, readable in the event switcher, and theirs to change — rather
 * than a guess from the email domain, which is wrong for every person signing up with a personal
 * address and faintly alarming when it is right. Clamped to the 120 characters the
 * `organizations.name` CHECK allows, so a very long display name cannot fail the insert.
 */
export function organizationNameFor(displayName: string): string {
  const trimmed = displayName.trim();
  const base = trimmed === "" ? "New organization" : trimmed;
  return base.length <= 120 ? base : `${base.slice(0, 119)}…`;
}

export interface SignInOutcome {
  readonly actor: Actor;
  /** True only when this sign-in created the account, so the surface can welcome them. */
  readonly provisioned: boolean;
}

// @spec PRD-IAM-001
export class SignupService {
  constructor(private readonly dependencies: SignupDependencies) {}

  /**
   * `intent` decides whether a first-time identity is given a conference to run.
   *
   * Outcome 3 provisioned an organization and a "Your first event" for **every** unrecognized
   * Google account, which is right for somebody who pressed the button on `/signin` and wrong for
   * a CFP submitter who pressed it on a public call page to keep track of a talk proposal. They
   * came for a proposal and were handed a conference workspace named after themselves, with an
   * empty event in it. Recorded as a residual of `GAP-027` and owned by nobody until this lane.
   *
   * The context travels on the attempt row rather than on the callback URL or a cookie — see
   * migration `1005` — and it only ever *withholds*, so it is not an authorization decision.
   *
   * **A submitter is not stranded by this.** `completeWorkspace` provisions for an account that
   * holds no organization and no event role whenever a sign-in asks for one, so the same person
   * signing in later through the organizer door gets the workspace then. The decision is about
   * this sign-in, not a permanent mark on the account.
   */
  async signInWithGoogle(
    identity: GoogleIdentity,
    intent: WorkspaceIntent = "organizer",
  ): Promise<SignInOutcome> {
    if (!identity.emailVerified)
      throw new UnverifiedProviderEmailError(
        "Google reports this address as unverified, so it cannot be linked to an account",
      );
    const { directory } = this.dependencies;
    const wantsWorkspace = intent !== "submitter";

    const linked = await directory.findByProviderAccount("google", identity.subject);
    if (linked)
      return {
        actor: wantsWorkspace ? await this.completeWorkspace(linked) : linked,
        provisioned: false,
      };

    const byAddress = await directory.findByEmail(identity.email);
    if (byAddress) {
      await directory.linkProviderAccount({
        provider: "google",
        subject: identity.subject,
        userId: byAddress.id,
        linkedAt: this.dependencies.now(),
      });
      // Deliberately not `completeWorkspace`: this identity already exists with whatever access
      // it was given, and a speaker who links Google is still a speaker.
      return {
        actor: (await directory.findByUserId(byAddress.id)) ?? byAddress,
        provisioned: false,
      };
    }

    /*
     * The organization is created *before* the identity batch that references it, so that a
     * failed batch can discard it (issue #164) — and a submitter creates no organization at all,
     * so there is nothing to discard and `recoverFromFailedIdentity` is not reached. That is why
     * the two paths are told apart here rather than inside the batch.
     */
    const organization = wantsWorkspace
      ? await this.dependencies.workspace.provisionOrganization({
          name: organizationNameFor(identity.name),
        })
      : null;
    const userId = this.dependencies.newId();
    try {
      await directory.createSelfServeIdentity({
        userId,
        name: identity.name,
        email: identity.email,
        provider: "google",
        subject: identity.subject,
        linkedAt: this.dependencies.now(),
        organizationId: organization?.id ?? null,
      });
    } catch (failure) {
      // ERROR-INTENT: not suppressed — `recoverFromFailedIdentity` is handed this failure and
      // either rethrows it, or signs the caller in as the racer that won and reports why the
      // organization it just created was discarded. Nothing here decides that a failure was
      // harmless. With no organization to discard there is nothing to recover *from*, and the
      // winner lookup is still owed to a racer whose account now exists, so the same method runs
      // with a null organization.
      return await this.recoverFromFailedIdentity(
        identity,
        organization?.id ?? null,
        failure,
        wantsWorkspace,
      );
    }
    const actor = await directory.findByUserId(userId);
    if (!actor)
      throw new ProvisioningFailedError("The account was written but could not be read back");
    return {
      actor: wantsWorkspace ? await this.completeWorkspace(actor) : actor,
      provisioned: true,
    };
  }

  /**
   * The losing racer's recovery, and the only place an organization is ever deleted.
   *
   * Two concurrent first sign-ins for one Google account both provision an organization and both
   * write the identity batch; the second fails whole on `identity_provider_accounts`' primary key
   * or on `identity_emails.email UNIQUE`. Before this, that left two marks: the loser's
   * organization row, unreferenced and swept by nothing (issue #164) — which, once the demo reset
   * reads the data (`GAP-019`), is a row that would make every later reset refuse — and a person
   * told their sign-in did not complete when in fact their account exists and works.
   *
   * So the organization is discarded, and then the winner is looked up: if the subject now
   * resolves, this callback signs in as that user, exactly as a returning one would. Anything
   * else is rethrown. Deliberately narrow — a *different* identity holding the address is a real
   * conflict, and linking it here would be account takeover by race — and the discard is
   * unconditional rather than conditional on winning, because an organization this call created
   * and could not use is an orphan whichever way the failure went.
   */
  private async recoverFromFailedIdentity(
    identity: GoogleIdentity,
    organizationId: string | null,
    failure: unknown,
    /** Carried through so the racer that wins is completed on the terms *this* sign-in asked for. */
    wantsWorkspace: boolean,
  ): Promise<SignInOutcome> {
    let discardFailure: unknown;
    // Nothing was created, so nothing is orphaned: a submitter sign-in leaves no organization
    // behind and takes the winner lookup below without a discard.
    let discarded = organizationId === null;
    try {
      // The count is load-bearing rather than decorative: `false` means the orphan is still
      // there, and nothing else in this repository will ever remove it.
      if (organizationId !== null)
        discarded = await this.dependencies.workspace.discardUnusedOrganization(organizationId);
    } catch (failedDiscard) {
      // ERROR-INTENT: held, reported below through `report`, and carried into the thrown error
      // when there is no winner to sign in. The orphan it names is the row a data-aware demo
      // reset refuses on, so the production composition binds a reporter (`index.ts`); a
      // composition that binds none — every test — is choosing not to hear about it.
      discardFailure = failedDiscard;
    }
    if (!discarded)
      this.dependencies.report?.(
        {
          organizationId,
          reason: message(failure),
          ...(discardFailure ? { discardError: message(discardFailure) } : {}),
        },
        "auth.signup.organization_not_discarded",
      );
    /*
     * The winner is looked up whether or not the discard succeeded, and that ordering matters in
     * exactly the case the discard's own guard describes: a batch that committed and lost its
     * response leaves a membership referencing the organization, so the delete is refused by the
     * foreign key — and the person whose account *does* now exist would otherwise be told their
     * sign-in failed.
     */
    const winner = await this.dependencies.directory.findByProviderAccount(
      "google",
      identity.subject,
    );
    if (winner)
      return {
        actor: wantsWorkspace ? await this.completeWorkspace(winner) : winner,
        provisioned: false,
      };
    if (discardFailure)
      throw new ProvisioningFailedError(
        `Signup failed (${message(failure)}) and organization ${organizationId} could not be discarded (${message(discardFailure)})`,
      );
    throw failure;
  }

  /**
   * Give an organizer their first event, if the previous attempt stopped before it did.
   *
   * Reached on every Google sign-in **that asked for a workspace** and does nothing in every
   * ordinary case. The condition is narrow on purpose — no event role at all — so a linked
   * speaker, who holds one, is never provisioned anything.
   *
   * **It provisions, and it never adopts.** One condition, and both halves of it are the
   * permission: an organization with **no events** and **no other member** is a workspace this
   * person owns and has not been given one for. Anything else is left alone.
   *
   * Each half answers a way the old "adopt the organization's first event" rule handed somebody
   * an event that was not theirs:
   *
   *   - *No other member.* An organization-level invitation writes a membership and no event
   *     role, which is exactly the state this method acts on. Provisioning into somebody else's
   *     empty organization would make the newcomer its organizer — and `identity:manage` over it —
   *     while stranding the owner, whose own next sign-in would then find it non-empty.
   *   - *No events.* An organization that already holds events is somebody's working workspace.
   *     Adopting one of them would grant `agenda:manage`, `review:manage` and
   *     `events:settings:update` on an event nobody granted, which organization membership
   *     deliberately does not confer — and would silently restore a role an organizer had
   *     deliberately revoked, because "somebody revoked my only role" and "my signup stopped
   *     early" are the same state seen from here.
   *
   * **Adoption still happens — one layer down, where it can be justified.** A caller that reaches
   * `createFirstEvent` is provisioning *now*, and the events domain answers it with the event
   * already provisioned under this person's key if a concurrent callback got there first (issue
   * #164). So two tabs converge on one event and one role, while a member who merely holds a
   * membership never reaches that call at all.
   *
   * The consequence, stated rather than hidden: a signup whose event creation failed *and* whose
   * organization has since gained a second member or an event is not resumed here. Their
   * membership already lets them create an event themselves, which is the affordance this method
   * is a convenience for.
   */
  private async completeWorkspace(actor: Actor): Promise<Actor> {
    if (actor.eventAccess.length > 0) return actor;
    const { workspace, directory } = this.dependencies;
    /*
     * An account with no organization at all, signing in through a door that asks for one.
     *
     * This used to return early, because the only way to hold no organization was to be a linked
     * speaker — and they hold an event role, which the line above already excludes. The submitter
     * door creates the other way: an identity that owns proposals and belongs to no conference.
     * That is the right shape for somebody proposing a talk, and it must not be a trap. Signing in
     * from `/signin` is them asking for a workspace, and this is where they get one.
     *
     * It provisions rather than adopting, exactly like the loop below: nothing here can hand
     * somebody an organization that already exists.
     */
    if (actor.organizations.length === 0) {
      const organization = await workspace.provisionOrganization({
        name: organizationNameFor(actor.name),
      });
      /*
       * **Storage picks the winner, and this is the whole of that promise.**
       *
       * Two tabs are ordinary here for exactly the reason the top of this file gives — a person
       * with two open tabs produces two callbacks (issue #166) — and this branch has no natural
       * arbiter of its own: `provisionOrganization` mints a fresh id every call, so two racers
       * create two organizations, and `INSERT OR IGNORE` on `(organization_id, user_id)` would let
       * *both* memberships land. Each would then get its own first event under its own
       * provisioning key, and the person would be left holding two conferences named after
       * themselves, with nothing in this repository able to delete either.
       *
       * So the membership insert is conditional on the account holding **no** membership at all,
       * and the row count is the answer: the loser wrote nothing, discards the organization it
       * created, and adopts the winner's workspace by re-reading. That is the same shape
       * `recoverFromFailedIdentity` uses one level up, for the same reason.
       */
      let joined: boolean;
      try {
        joined = await directory.joinOrganization(organization.id, actor.id);
      } catch (failure) {
        // ERROR-INTENT: rethrown, after removing the organization this call created and could not
        // use. An unreferenced organization is invisible to the product and is the row a
        // data-aware demo restore refuses on for ever (`GAP-019`), so it is discarded on exactly
        // the ordering grounds the top of this file states — never suppressed.
        await workspace.discardUnusedOrganization(organization.id);
        throw failure;
      }
      if (!joined) {
        // Somebody else's callback got there first. Nothing here is theirs to keep.
        await workspace.discardUnusedOrganization(organization.id);
        const winner = (await directory.findByUserId(actor.id)) ?? actor;
        // Re-entered rather than recursed once: the winner may itself still be mid-provisioning,
        // in which case this actor now holds their organization and takes the loop below, which
        // is idempotent per person per organization through the events domain's own key.
        return winner.organizations.length === 0 ? winner : this.completeWorkspace(winner);
      }
      /*
       * Re-read before creating the event, so the creation is authorized by the membership that
       * now exists rather than by an actor assembled here. A fabricated actor is an authorization
       * check that has stopped meaning anything, and this is the one place in the flow where it
       * would have been tempting.
       */
      const member = (await directory.findByUserId(actor.id)) ?? actor;
      const first = await workspace.createFirstEvent(member, {
        organizationId: organization.id,
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      });
      await directory.grantOrganizer(first.id, actor.id);
      return (await directory.findByUserId(actor.id)) ?? member;
    }
    /*
     * Every organization this actor belongs to, rather than `organizations[0]`: that index is a
     * sort order and not a choice, so a person whose own signup stalled *and* who has since been
     * invited elsewhere would otherwise have their workspace completed — or silently not —
     * according to which organization id sorts first.
     */
    /*
     * Whether an organization was skipped because it already holds an event.
     *
     * That is what the loser of a promotion race sees: it re-entered here holding the winner's
     * organization, the winner's event already exists, so there is nothing to provision — and
     * returning `actor` returns the snapshot read *before* the winner granted the role. The tab
     * that lost then gets a session with no event access and shows the person no workspace at all
     * until they reload, while the other tab shows one. The row is right and the answer is stale,
     * so the answer is re-read, and only on the path that can be stale.
     */
    let sawExistingEvent = false;
    for (const { id } of actor.organizations) {
      /*
       * Two reads, and neither can be made atomic with the write that follows. Both directions of
       * the window are harmless enough that no compare-and-swap is reached for.
       *
       * An event arriving between them almost always comes from a concurrent callback for this
       * same person, and the provisioning key hands this caller that event rather than a second
       * one. The exception is an event they create *by hand* through `POST /api/events` in the
       * same window — their membership authorizes it — which would leave them holding two events,
       * one of them named "Your first event". That is the duplicate #164 is about, at a width of
       * milliseconds and requiring the person to be racing themselves.
       *
       * A second member arriving between them means somebody joined an organization that was
       * empty when both reads ran, and this person still receives a brand-new event of their own
       * rather than anything that already existed.
       */
      if ((await workspace.eventsInOrganization(actor, id)).length > 0) {
        sawExistingEvent = true;
        continue;
      }
      if ((await directory.countOrganizationMembers(id)) !== 1) continue;
      // Creates, or is handed the event a concurrent callback for this same person provisioned a
      // moment ago under their shared key. Either way the role that opens it lands in the same
      // durable write, and granting it again here is `INSERT OR IGNORE`.
      const first = await workspace.createFirstEvent(actor, {
        organizationId: id,
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      });
      await directory.grantOrganizer(first.id, actor.id);
      // Re-read rather than patched in memory: the event role the creation granted is what
      // decides every capability the session is about to be issued with, and D1 holds it.
      return (await directory.findByUserId(actor.id)) ?? actor;
    }
    return sawExistingEvent ? ((await directory.findByUserId(actor.id)) ?? actor) : actor;
  }
}
