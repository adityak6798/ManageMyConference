/**
 * The list of domains contributing paths to the OpenAPI document.
 *
 * A domain adds itself with one import and one array entry. The document's own path order is
 * sorted at generation time, so adding a fragment does not reshuffle the artifact and the
 * order of this list carries no meaning beyond readability.
 *
 * @spec ARC-001 ENG-CI-001
 */
import { agendaPaths } from "./agenda";
import { cfpPaths } from "./cfp";
import { communicationsPaths } from "./communications";
import { contentPaths } from "./content";
import type { OpenApiFragment } from "./contract";
import { crmPaths } from "./crm";
import { eventsPaths } from "./events";
import { identityPaths } from "./identity";
import { platformPaths } from "./platform";
import { publishingPaths } from "./publishing";
import { reviewPaths } from "./review";

export const openApiFragments: readonly OpenApiFragment[] = [
  platformPaths,
  identityPaths,
  eventsPaths,
  cfpPaths,
  reviewPaths,
  contentPaths,
  crmPaths,
  agendaPaths,
  communicationsPaths,
  publishingPaths,
];
