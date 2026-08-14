/** The identity-access application surface composed by transports and adapters. */
export type {
  CustomRole,
  CustomRoleAssignment,
  CustomRoleDraft,
  CustomRoleFieldPolicy,
  CustomRoleRepository,
} from "./custom-roles";
export {
  CustomRoleConflictError,
  CustomRoleInvalidError,
  CustomRoleNameTakenError,
  CustomRoleNotFoundError,
  CustomRoleRefusedError,
  CustomRoleService,
  customRoleTemplates,
  governedFieldCatalogue,
} from "./custom-roles";
/**
 * Per-field access, which other domains consume to narrow their own projections and exports.
 *
 * Exported here rather than deep-imported so that widening what a policy can govern is a visible
 * edit to one surface. `fieldAccessFor` is a pure function of the actor, which is what lets a
 * screen, a CSV and a report reach the same decision by construction.
 */
export type {
  FieldAccess,
  FieldPolicy,
  FieldSubject,
  HideableContactField,
  HideableSessionField,
  HideableSpeakerField,
  Redacted,
} from "./field-access";
export {
  fieldAccessAcross,
  fieldAccessFor,
  FieldLockedError,
  GOVERNED_FIELDS,
  GRANTABLE_CAPABILITIES,
} from "./field-access";
export {
  LastAdministratorError,
  requireOrganizationAdministration,
} from "./organization-administration";
export type { ApiClientEventDirectory, ApiClientRepository } from "./api-clients";
export {
  ApiClientConflictError,
  ApiClientInputError,
  ApiClientNotFoundError,
  ApiClientResolver,
  ApiClientService,
  hashApiClientSecret,
  mintApiClientCredential,
} from "./api-clients";
