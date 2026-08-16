/**
 * The list of domain workspaces in the console.
 *
 * This is the whole extension point. A domain adds a surface with one import and one array
 * entry; `App.tsx` derives the sidebar, the icon for each item, and which component renders
 * from this list, so none of those three is a file every domain edits any more.
 *
 * `/` and `/settings` are deliberately absent: they are the shell's own surfaces, not a
 * domain's, and they render from `App.tsx` with its own form state.
 *
 * @spec ARC-001 ARC-DOM-001
 */
import { agendaWorkspace, scheduleAgendaTab } from "./agenda";
import { apiClientsHubTab, apiClientsWorkspace } from "./api-clients";
import { cfpWorkspace, programFormsTab } from "./cfp";
import {
  communicationsWorkspace,
  communicationTemplatesHubTab,
  composeHubTab,
  deliveryHubTab,
} from "./communications";
import {
  filesHubTab,
  portalWorkspace,
  scheduleSessionsTab,
  sessionsWorkspace,
  speakersHubTab,
  tasksHubTab,
} from "./content";
import type {
  HubTabModule,
  NavGroupName,
  WorkspaceAccess,
  WorkspaceHub,
  WorkspaceModule,
} from "./contract";
import { crmDirectoryWorkspace, crmHubTab, crmWorkspace, directoryHubTab } from "./crm";
import { customRolesWorkspace, rolesHubTab } from "./custom-roles";
import { eventSettingsHubTab, eventTemplatesHubTab, eventTemplatesWorkspace } from "./events";
import { membersWorkspace, teamHubTab } from "./identity";
import { activityHubTab, auditWorkspace, inboxWorkspace, searchWorkspace } from "./platform";
import { embedsHubTab, eventSiteHubTab, publishingWorkspace } from "./publishing";
import { reportsHubTab, reportsWorkspace } from "./reports";
import {
  abstractsWorkspace,
  programReviewTab,
  programSubmissionsTab,
  reviewsWorkspace,
} from "./review";
import { portalsHubTab, sitesWorkspace } from "./sites";
import { webhooksHubTab, webhooksWorkspace } from "./webhooks";

export const workspaceModules: readonly WorkspaceModule[] = [
  abstractsWorkspace,
  sessionsWorkspace,
  agendaWorkspace,
  cfpWorkspace,
  crmWorkspace,
  crmDirectoryWorkspace,
  membersWorkspace,
  customRolesWorkspace,
  apiClientsWorkspace,
  communicationsWorkspace,
  publishingWorkspace,
  sitesWorkspace,
  reviewsWorkspace,
  portalWorkspace,
  eventTemplatesWorkspace,
  searchWorkspace,
  inboxWorkspace,
  reportsWorkspace,
  auditWorkspace,
  webhooksWorkspace,
];

/** Complete organizer information architecture, registered atomically by the cutover issue. */
export const hubTabModules: readonly HubTabModule[] = [
  programFormsTab,
  {
    ...programSubmissionsTab,
    label: "Review",
    header: programReviewTab.header,
  },
  { ...programReviewTab, hidden: true, canonicalTab: programSubmissionsTab.tab },
  crmHubTab,
  directoryHubTab,
  speakersHubTab,
  { ...tasksHubTab, hidden: true, canonicalTab: speakersHubTab.tab },
  { ...filesHubTab, hidden: true, canonicalTab: speakersHubTab.tab },
  scheduleSessionsTab,
  scheduleAgendaTab,
  {
    ...composeHubTab,
    label: "Messages",
    header: () => ({
      eyebrow: "Communications",
      title: "Messages",
      subtitle: "Compose event messages, manage their templates, and inspect delivery outcomes.",
    }),
  },
  { ...communicationTemplatesHubTab, hidden: true, canonicalTab: composeHubTab.tab },
  { ...deliveryHubTab, hidden: true, canonicalTab: composeHubTab.tab },
  {
    ...eventSiteHubTab,
    label: "Publishing",
    header: () => ({
      eyebrow: "Publish",
      title: "Publishing",
      subtitle: "Preview and publish the event site, public feeds, and embeddable programme views.",
    }),
  },
  portalsHubTab,
  { ...embedsHubTab, hidden: true, canonicalTab: eventSiteHubTab.tab },
  eventSettingsHubTab,
  teamHubTab,
  rolesHubTab,
  // Integrations is one job even though two bounded contexts contribute its controls. The
  // shell composes both renderers below instead of exposing duplicate tabs with one URL.
  {
    ...apiClientsHubTab,
    canAccess: (access) =>
      canOpenTab(apiClientsHubTab, access) || canOpenTab(webhooksHubTab, access),
    legacyPaths: [...apiClientsHubTab.legacyPaths, ...webhooksHubTab.legacyPaths],
    render: (context) => (
      <>
        {canOpenTab(apiClientsHubTab, context) ? apiClientsHubTab.render(context) : null}
        {canOpenTab(webhooksHubTab, context) ? webhooksHubTab.render(context) : null}
      </>
    ),
  },
  eventTemplatesHubTab,
  reportsHubTab,
  activityHubTab,
];

export function hubTabsFor(hub: WorkspaceHub, persona: string): HubTabModule[] {
  return hubTabModules
    .filter(
      (module) =>
        module.hub === hub && !module.hidden && module.personas.includes(persona as never),
    )
    .sort((left, right) => left.order - right.order);
}

export function hubTabForSelection(
  hub: WorkspaceHub,
  tab: string | null,
  persona: string,
): HubTabModule | undefined {
  if (!tab) return undefined;
  const selected = hubTabModules.find(
    (module) =>
      module.hub === hub && module.tab === tab && module.personas.includes(persona as never),
  );
  if (!selected?.hidden) return selected;
  return hubTabModules.find(
    (module) =>
      module.hub === hub &&
      module.tab === selected.canonicalTab &&
      !module.hidden &&
      module.personas.includes(persona as never),
  );
}

export function hubTabForLegacyPath(path: string): HubTabModule | undefined {
  return hubTabModules.find((module) => module.legacyPaths.includes(path));
}

export function canOpenTab(module: HubTabModule, access: WorkspaceAccess): boolean {
  return module.canAccess ? module.canAccess(access) : true;
}

/**
 * Refuse to build a console in which two domains claim one route.
 *
 * The symptom otherwise is whichever module `find` reached first quietly winning, with the
 * other domain's workspace simply never rendering and nothing anywhere saying so.
 */
export function assertNoDuplicateWorkspaces(
  modules: readonly WorkspaceModule[] = workspaceModules,
): void {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const module of modules) {
    const existing = owners.get(module.path);
    if (existing)
      conflicts.push(`${module.path} is claimed by both '${existing}' and '${module.domain}'`);
    else owners.set(module.path, module.domain);
  }
  if (conflicts.length > 0)
    throw new Error(
      `Duplicate workspace registration:\n  ${conflicts.join("\n  ")}\n` +
        "Each route belongs to exactly one domain module in apps/web/src/workspaces.",
    );
}

/** Sidebar entries for a persona, in declared order. */
export function workspacesForPersona(
  persona: string,
  modules: readonly WorkspaceModule[] = workspaceModules,
): WorkspaceModule[] {
  return modules
    .filter((module) => module.personas.includes(persona as never))
    .sort((left, right) => left.order - right.order);
}

export function workspaceForPath(
  path: string,
  modules: readonly WorkspaceModule[] = workspaceModules,
): WorkspaceModule | undefined {
  return modules.find((module) => module.path === path);
}

export function canOpen(module: WorkspaceModule, access: WorkspaceAccess): boolean {
  return module.canAccess ? module.canAccess(access) : true;
}

export const NAV_GROUP_ORDER: readonly NavGroupName[] = ["home", "Program", "Audience"];
