/**
 * The list of domains on the HTTP surface.
 *
 * This is the whole extension point. A domain adds itself with one import and one array
 * entry; everything else about its routes lives in its own module. Registration order is
 * Hono's matching order, so it is kept deliberate rather than alphabetical: `publishing`
 * registers `/api/public/events/:slug` and `cfp` registers `/api/public/events/:eventId/cfp`,
 * and the more specific of the two has to be reachable.
 *
 * @spec ARC-001 ARC-DOM-001
 */
import { agendaRoutes } from "./agenda";
import { cfpRoutes } from "./cfp";
import { communicationsRoutes } from "./communications";
import { contentRoutes } from "./content";
import type { RouteModule } from "./contract";
import { crmRoutes } from "./crm";
import { eventsRoutes } from "./events";
import { identityRoutes } from "./identity";
import { publishingRoutes } from "./publishing";
import { reviewRoutes } from "./review";

export const routeModules: readonly RouteModule[] = [
  publishingRoutes,
  identityRoutes,
  eventsRoutes,
  communicationsRoutes,
  contentRoutes,
  reviewRoutes,
  cfpRoutes,
  crmRoutes,
  agendaRoutes,
];

/**
 * Refuse to build an app in which two domains claim one route.
 *
 * Hono would simply let the first registration win, so the symptom of a bad merge would be a
 * route that quietly answers from the wrong domain — with no error anywhere. Naming both
 * domains at construction turns that into a failure a test sees immediately.
 */
export function assertNoDuplicateRoutes(modules: readonly RouteModule[]): void {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const module of modules)
    for (const route of module.routes) {
      const existing = owners.get(route);
      if (existing)
        conflicts.push(`${route} is claimed by both '${existing}' and '${module.domain}'`);
      else owners.set(route, module.domain);
    }
  if (conflicts.length > 0)
    throw new Error(
      `Duplicate HTTP route registration:\n  ${conflicts.join("\n  ")}\n` +
        "Each route belongs to exactly one domain module in apps/api/src/transport/http/routes.",
    );
}

/** Every route the transport serves, with its owning domain. Used by the context checks. */
export function declaredRoutes(
  modules: readonly RouteModule[] = routeModules,
): { route: string; domain: string }[] {
  return modules.flatMap((module) =>
    module.routes.map((route) => ({ route, domain: module.domain })),
  );
}
