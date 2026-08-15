/**
 * The extension point a domain implements to put a workspace in the console.
 *
 * A domain adds a surface by writing one module in this directory and adding one line to
 * `registry.tsx`. Before this, a new workspace meant editing three separate places in
 * `App.tsx` — the per-persona route table, the icon map, and the `renderPage` switch — all of
 * which every other domain was editing too.
 *
 * @spec ARC-001 ARC-DOM-001 PRD-IAM-002
 */
import type { EventDto, SessionDto } from "@greenroom/contracts";
import type { ReactNode } from "react";
import type { Persona } from "../AppShell";
export type WorkspaceRole = Persona | "custom";

/** Sidebar grouping. `home` is the ungrouped first item. */
export type NavGroupName = "home" | "Program" | "Audience";

/**
 * The stable, job-shaped destinations of the redesigned organizer console.
 *
 * Existing workspaces keep using `WorkspaceModule` until their owning lane is ready. A lane may
 * export `HubTabModule`s without registering them; the final #237 cutover composes the complete
 * set in one place so a partially rebuilt hub is never exposed in primary navigation.
 */
export type WorkspaceHub =
  | "program"
  | "people"
  | "schedule"
  | "communications"
  | "publish"
  | "settings";

export const HUB_PATHS: Readonly<Record<WorkspaceHub, string>> = {
  program: "/program",
  people: "/people",
  schedule: "/schedule",
  communications: "/communications",
  publish: "/publish",
  settings: "/settings",
};

/** Build a shareable hub URL without owning event or record query state. */
export function hubTabHref(hub: WorkspaceHub, tab: string): string {
  const query = new URLSearchParams({ tab });
  return `${HUB_PATHS[hub]}?${query.toString()}`;
}

/** What a workspace may consult to decide whether this identity can open it. */
export interface WorkspaceAccess {
  session: SessionDto | null;
  activeRole: WorkspaceRole;
  /**
   * Capabilities scoped to the selected event, never the actor-level union. The union is
   * every event the actor can touch, so testing it would let an organizer of event A mount
   * event B's workspace and fire its requests.
   */
  capabilities: readonly string[];
  isEventOrganizer: boolean;
}

/** Everything a workspace needs to render itself. */
export interface WorkspaceContext extends WorkspaceAccess {
  event: EventDto;
  query: string;
  agendaLoadFailure: string | null;
  reportAgendaLoadFailure: (message: string) => void;
  onPublicationChange: (publication: { state: string; slug: string } | null) => void;
}

export interface WorkspaceHeader {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}

export interface WorkspaceModule {
  /** The `context-manifest.json` domain that owns this workspace. */
  readonly domain: string;
  /** Its route, which is also its identity in the sidebar. */
  readonly path: string;
  readonly label: string;
  readonly group: NavGroupName;
  /** Sidebar position within the persona's list. */
  readonly order: number;
  readonly icon: ReactNode;
  /**
   * Personas that see this in the sidebar. Deliberately separate from `canAccess`: an
   * organizer sees every organizer surface listed even where a capability is missing, and
   * opening one then explains the refusal rather than hiding that it exists.
   */
  readonly personas: readonly Persona[];
  /** Absent means the persona check is the whole gate. */
  canAccess?(access: WorkspaceAccess): boolean;
  header(context: WorkspaceContext): WorkspaceHeader;
  render(context: WorkspaceContext): ReactNode;
}

/** A domain-owned contribution to one job-shaped hub, registered only at final cutover. */
export interface HubTabModule {
  readonly domain: string;
  readonly hub: WorkspaceHub;
  readonly tab: string;
  readonly label: string;
  readonly order: number;
  readonly icon?: ReactNode;
  readonly personas: readonly Persona[];
  /** Compatibility-only route aliases are resolvable but not advertised as distinct jobs. */
  readonly hidden?: boolean;
  /** Old console paths that should resolve to this tab after cutover. */
  readonly legacyPaths: readonly string[];
  canAccess?(access: WorkspaceAccess): boolean;
  header(context: WorkspaceContext): WorkspaceHeader;
  render(context: WorkspaceContext): ReactNode;
}
