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
import { agendaWorkspace } from "./agenda";
import { cfpWorkspace } from "./cfp";
import { communicationsWorkspace } from "./communications";
import { portalWorkspace, sessionsWorkspace } from "./content";
import type { NavGroupName, WorkspaceAccess, WorkspaceModule } from "./contract";
import { crmWorkspace } from "./crm";
import { publishingWorkspace } from "./publishing";
import { abstractsWorkspace, reviewsWorkspace } from "./review";

export const workspaceModules: readonly WorkspaceModule[] = [
  abstractsWorkspace,
  sessionsWorkspace,
  agendaWorkspace,
  cfpWorkspace,
  crmWorkspace,
  communicationsWorkspace,
  publishingWorkspace,
  reviewsWorkspace,
  portalWorkspace,
];

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
