// @spec ARC-DOM-001
// Composition root: adding a domain's storage declarations is one import and one array entry.
import { defineAgendaSchema } from "./agenda.ts";
import { defineCfpSchema } from "./cfp.ts";
import { defineCommunicationsIntegrationsSchema } from "./communications-integrations.ts";
import { defineContentSchema } from "./content.ts";
import { defineCrmSchema } from "./crm.ts";
import { defineEventsSchema } from "./events.ts";
import { defineIdentityAccessSchema } from "./identity-access.ts";
import { definePlatformSchema } from "./platform.ts";
import { definePublishingSchema } from "./publishing.ts";
import { defineReviewSchema } from "./review.ts";

const eventsSchema = defineEventsSchema();
const identityAccessSchema = defineIdentityAccessSchema({
  eventsId: eventsSchema.events.id,
  organizationsId: eventsSchema.organizations.id,
});
const cfpSchema = defineCfpSchema({
  eventsId: eventsSchema.events.id,
  usersId: identityAccessSchema.users.id,
});
const contentSchema = defineContentSchema({
  eventsId: eventsSchema.events.id,
  usersId: identityAccessSchema.users.id,
});
const reviewSchema = defineReviewSchema({
  cfpSubmissionsId: cfpSchema.cfpSubmissions.id,
  eventsId: eventsSchema.events.id,
  usersId: identityAccessSchema.users.id,
});
const crmSchema = defineCrmSchema({
  eventsId: eventsSchema.events.id,
  organizationsId: eventsSchema.organizations.id,
  speakerProfilesId: contentSchema.speakerProfiles.id,
  usersId: identityAccessSchema.users.id,
});
const agendaSchema = defineAgendaSchema({
  eventsId: eventsSchema.events.id,
  usersId: identityAccessSchema.users.id,
});
const communicationsIntegrationsSchema = defineCommunicationsIntegrationsSchema({
  eventsId: eventsSchema.events.id,
  organizationsId: eventsSchema.organizations.id,
});
const publishingSchema = definePublishingSchema({ eventsId: eventsSchema.events.id });
const platformSchema = definePlatformSchema({
  eventsId: eventsSchema.events.id,
  usersId: identityAccessSchema.users.id,
});

export const schemaFragments = [
  agendaSchema,
  cfpSchema,
  communicationsIntegrationsSchema,
  contentSchema,
  crmSchema,
  eventsSchema,
  identityAccessSchema,
  publishingSchema,
  reviewSchema,
  platformSchema,
];

export const schema = {
  ...agendaSchema,
  ...cfpSchema,
  ...communicationsIntegrationsSchema,
  ...contentSchema,
  ...crmSchema,
  ...eventsSchema,
  ...identityAccessSchema,
  ...publishingSchema,
  ...reviewSchema,
  ...platformSchema,
};

export const {
  apiClientEvents,
  apiClientScopes,
  apiClients,
  accelEventsSyncRuns,
  calendarInviteStates,
  agendaDrafts,
  agendaPublications,
  agendaScheduleMaterializations,
  agendaSessionSchedules,
  attendeeItineraries,
  cfpForms,
  cfpStatusAudit,
  cfpStatuses,
  cfpSubmissions,
  communicationAttempts,
  communicationDeliveries,
  contentSessions,
  contentAssetComments,
  contentRevisions,
  contentSpeakerImportRows,
  crmActivities,
  crmContactActivities,
  crmContactAliases,
  crmContactEvents,
  crmContactFields,
  crmContactImports,
  crmContacts,
  crmContactSegments,
  crmContactTags,
  crmOrganizationContacts,
  crmPipelineStages,
  crmProspects,
  crmProspectTransitions,
  eventRoles,
  events,
  eventTemplates,
  eventTemplateVersions,
  eventTemplateApplications,
  identityAuditEvents,
  identityEmails,
  identityInvitations,
  identityLoginChallenges,
  identityOauthAttempts,
  identityProviderAccounts,
  identitySessions,
  messageTemplates,
  organizationMemberships,
  organizations,
  outboundProjectionState,
  platformAuditRecords,
  platformInboxDismissals,
  publicEventProjections,
  reviewAssignments,
  reviewAssignmentCaps,
  reviewConflicts,
  reviewDecisions,
  reviewEvaluations,
  reviewEvents,
  reviewOutcomes,
  reviewPlans,
  reviewRounds,
  reviewRoundMembers,
  reviewSuggestions,
  speakerAssets,
  speakerConversionClaims,
  speakerConversionSources,
  speakerEmailClaims,
  speakerMessages,
  speakerProfiles,
  speakerResources,
  speakerTasks,
  speakerTaskTemplates,
  users,
  webhookSubscriptions,
  webhookSubscriptionEventTypes,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookIdempotencyRecords,
  publicEventProjectionVersions,
} = schema;
