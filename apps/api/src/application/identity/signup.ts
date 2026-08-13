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
 *   1. the organization row — orphaned and invisible if we stop here, since nothing references it;
 *   2. the identity batch — user, address, provider link and membership commit together or not
 *      at all, so a half-made account cannot sign in;
 *   3. the first event, which grants the organizer role.
 *
 * A failure at (3) leaves a user holding an organization and no event role, and `completeWorkspace`
 * treats exactly that state as resumable on the next sign-in. That condition is safe because it is
 * unreachable any other way: this product has no path that removes an organizer's last event.
 *
 * @spec PRD-IAM-001 PRD-EVT-001
 */
import type { Actor } from "./actor";
import type { GoogleIdentity } from "./google-oauth";

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
  /** `INSERT OR IGNORE`, so adopting an event a previous attempt created is safe to repeat. */
  grantOrganizer(eventId: string, userId: string): Promise<void>;
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
    organizationId: string;
  }): Promise<void>;
}

/**
 * The events domain's side of provisioning, bound in the composition root to its public
 * application interface. Identity names what it needs; it never learns a table.
 */
export interface WorkspaceProvisioning {
  provisionOrganization(command: { name: string }): Promise<{ id: string }>;
  createFirstEvent(
    actor: Actor,
    command: { organizationId: string; name: string; timezone: string },
  ): Promise<{ id: string }>;
  /**
   * The events this organization already holds. Read before provisioning a first one, so a
   * resumed signup adopts the event a previous attempt left behind instead of making another.
   */
  eventsInOrganization(actor: Actor, organizationId: string): Promise<readonly { id: string }[]>;
}

export interface SignupDependencies {
  directory: SignupDirectory;
  workspace: WorkspaceProvisioning;
  newId: () => string;
  now: () => number;
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

  async signInWithGoogle(identity: GoogleIdentity): Promise<SignInOutcome> {
    if (!identity.emailVerified)
      throw new UnverifiedProviderEmailError(
        "Google reports this address as unverified, so it cannot be linked to an account",
      );
    const { directory } = this.dependencies;

    const linked = await directory.findByProviderAccount("google", identity.subject);
    if (linked) return { actor: await this.completeWorkspace(linked), provisioned: false };

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

    const organization = await this.dependencies.workspace.provisionOrganization({
      name: organizationNameFor(identity.name),
    });
    const userId = this.dependencies.newId();
    await directory.createSelfServeIdentity({
      userId,
      name: identity.name,
      email: identity.email,
      provider: "google",
      subject: identity.subject,
      linkedAt: this.dependencies.now(),
      organizationId: organization.id,
    });
    const actor = await directory.findByUserId(userId);
    if (!actor)
      throw new ProvisioningFailedError("The account was written but could not be read back");
    return { actor: await this.completeWorkspace(actor), provisioned: true };
  }

  /**
   * Give an organizer their first event, if the previous attempt stopped before it did.
   *
   * Reached on every Google sign-in and does nothing in every ordinary case. The condition is
   * narrow on purpose — an organization but no event role at all — so a user who simply has not
   * been added to an event by somebody else is never handed one, and a linked speaker (no
   * organization) is never provisioned anything.
   *
   * **It adopts before it creates, and that is the whole reason this reads the organization
   * first.** `EventService.create` writes the event row and the organizer role as two separate
   * calls, so a failure between them leaves precisely the state this method treats as resumable:
   * an organization, an event, and no role on it. Creating unconditionally would then hand the
   * user a *second* "Your first event" on their next sign-in — two identical entries in the
   * switcher, the older of which refuses `/settings` because the role it never got is what
   * grants `events:settings:update`. Adopting converges instead: the role is granted on the
   * event already there, and `grantOrganizer` is `INSERT OR IGNORE`, so repeating it is free.
   *
   * This narrows the concurrent case without closing it: two callbacks that both read an empty
   * organization before either writes still create two events. Closing that needs uniqueness the
   * events domain would have to declare, so it is recorded rather than half-solved here.
   */
  private async completeWorkspace(actor: Actor): Promise<Actor> {
    if (actor.organizations.length === 0 || actor.eventAccess.length > 0) return actor;
    const organizationId = actor.organizations[0]?.id;
    if (!organizationId) return actor;
    const existing = await this.dependencies.workspace.eventsInOrganization(actor, organizationId);
    const adopted = existing[0];
    if (adopted) await this.dependencies.directory.grantOrganizer(adopted.id, actor.id);
    else
      await this.dependencies.workspace.createFirstEvent(actor, {
        organizationId,
        name: FIRST_EVENT_NAME,
        timezone: DEFAULT_TIMEZONE,
      });
    // Re-read rather than patched in memory: the event role the creation granted is what decides
    // every capability the session is about to be issued with, and it is D1 that holds it.
    return (await this.dependencies.directory.findByUserId(actor.id)) ?? actor;
  }
}
