import { knownRouteNames, routeEntryOf } from "../routing/route-table";
import type { RegisteredRouteTypeSnapshot } from "./generate-route-types";
import { writeRouteTypes, type WriteRouteTypesResult } from "./write-route-types";

export type WriteCurrentRouteTypesInput = Readonly<{
  appRoot: string;
  apis: readonly RegisteredRouteTypeSnapshot[];
}>;

/**
 * Write route declarations from the page table installed by the Web connector
 * and the Core API snapshot supplied by its caller. This intentionally does
 * not discover pages or import controllers.
 */
export async function writeCurrentRouteTypes({
  appRoot,
  apis,
}: WriteCurrentRouteTypesInput): Promise<WriteRouteTypesResult> {
  const pages: RegisteredRouteTypeSnapshot[] = [];

  for (const name of knownRouteNames()) {
    const entry = routeEntryOf(name);

    if (entry === undefined) continue;

    // Keep what the dev installer read statically (actions, guard) so a dev rewrite does not
    // silently drop the typings `generate.typings` emits for the same pages.
    pages.push({
      name,
      path: entry.path,
      method: "GET",
      ...(entry.actions === undefined ? {} : { actions: entry.actions }),
      ...(entry.guard === undefined ? {} : { guard: entry.guard }),
    });
  }

  return writeRouteTypes({ appRoot, pages, apis });
}
