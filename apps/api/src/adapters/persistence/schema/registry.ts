// @spec ARC-DOM-001
// Composition root: adding a domain's storage declarations is one import and one array entry.
import { defineAgendaSchema } from "./agenda.ts";
import { defineCfpSchema } from "./cfp.ts";
import { defineCommunicationsIntegrationsSchema } from "./communications-integrations.ts";
import { defineContentSchema } from "./content.ts";
import { defineCrmSchema } from "./crm.ts";
import { defineEventsSchema } from "./events.ts";
import { defineIdentityAccessSchema } from "./identity-access.ts";
import { definePublishingSchema } from "./publishing.ts";
import { defineReviewSchema } from "./review.ts";

const eventsSchema = defineEventsSchema();
const identityAccessSchema = defineIdentityAccessSchema({
  eventsId: eventsSchema.events.id,
  organizationsId: eventsSchema.organizations.id,
});
const cfpSchema = defineCfpSchema({ eventsId: eventsSchema.events.id });
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
};

export const {
  agendaDrafts,
  agendaPublications,
  cfpForms,
  cfpStatusAudit,
  cfpStatuses,
  cfpSubmissions,
  communicationAttempts,
  communicationDeliveries,
  contentSessions,
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
  crmProspects,
  eventRoles,
  events,
  identityEmails,
  identityLoginChallenges,
  messageTemplates,
  organizationMemberships,
  organizations,
  outboundProjectionState,
  publicEventProjections,
  reviewAssignments,
  reviewConflicts,
  reviewDecisions,
  reviewEvaluations,
  reviewEvents,
  reviewOutcomes,
  reviewPlans,
  speakerAssets,
  speakerConversionClaims,
  speakerConversionSources,
  speakerEmailClaims,
  speakerMessages,
  speakerProfiles,
  speakerTasks,
  users,
} = schema;
