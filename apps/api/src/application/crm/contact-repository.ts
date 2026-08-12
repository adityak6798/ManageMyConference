import type {
  ContactActivity,
  ContactAlias,
  ContactImport,
  ContactSegment,
  DirectoryFilters,
  OrganizationContact,
} from "../../domain/crm/contact";
import type { Prospect } from "../../domain/crm/prospect";

/**
 * Storage for the organization-wide directory.
 *
 * Every read is scoped by `organizationId` in the signature rather than by a filter the caller
 * may forget to pass: an organization id is not optional anywhere here, so there is no shape of
 * this interface that can return another organization's contacts.
 *
 * @spec PRD-CRM-001
 */
export interface CrmDirectoryRepository {
  listContacts(
    organizationId: string,
    filters: DirectoryFilters,
  ): Promise<readonly OrganizationContact[]>;
  findContact(organizationId: string, contactId: string): Promise<OrganizationContact | null>;
  /**
   * `email` is expected normalized. Resolves through aliases, so an address a merge folded away
   * finds the survivor rather than nothing — otherwise re-importing the same sheet recreates the
   * duplicate the merge just removed.
   */
  findContactByEmail(organizationId: string, email: string): Promise<OrganizationContact | null>;
  /**
   * The same resolution for many addresses at once, keyed by the address asked for.
   *
   * An import classified rows one lookup at a time, which is one serial round trip per row of
   * the file before anything is written.
   */
  findContactsByEmails(
    organizationId: string,
    emails: readonly string[],
  ): Promise<Map<string, OrganizationContact>>;
  createContact(contact: OrganizationContact): Promise<void>;
  /**
   * Persist the contact with everything this command produced. `tags` and `fields` on the
   * supplied record replace what is stored, so a removed tag disappears rather than lingering.
   */
  updateContact(
    contact: OrganizationContact,
    activities?: readonly ContactActivity[],
  ): Promise<void>;
  /**
   * One import, one durable write. The batch record and every row it created or updated land
   * together, so a half-applied file cannot leave contacts nothing accounts for.
   */
  commitImport(
    record: ContactImport,
    created: readonly OrganizationContact[],
    updated: readonly OrganizationContact[],
  ): Promise<void>;
  /**
   * Fold `duplicateIds` into `primaryId`. Activity and event links move to the primary and the
   * losing rows keep a `merged_into_id` pointer, so nothing is deleted and every history entry
   * a merged record carried is still readable on the survivor.
   */
  mergeContacts(input: {
    organizationId: string;
    primaryId: string;
    duplicateIds: readonly string[];
    aliases: readonly ContactAlias[];
    activity: ContactActivity;
  }): Promise<OrganizationContact>;
  listSegments(organizationId: string): Promise<readonly ContactSegment[]>;
  findSegment(organizationId: string, segmentId: string): Promise<ContactSegment | null>;
  createSegment(segment: ContactSegment): Promise<void>;
  listImports(organizationId: string): Promise<readonly ContactImport[]>;
  /** Append history to several contacts at once, as one bulk send does. */
  recordContactActivities(
    organizationId: string,
    entries: readonly { contactId: string; activity: ContactActivity }[],
  ): Promise<void>;
  /**
   * Source a directory contact into one event: the event's prospect row, its primary contact
   * row and the directory link are one write, so a link can never point at a prospect that was
   * never stored.
   */
  linkContactToEvent(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }): Promise<void>;
}
