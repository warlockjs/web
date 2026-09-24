import { knownRouteNames, routePathOf } from "../routing/route-table";
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
    const path = routePathOf(name);
    if (path !== undefined) pages.push({ name, path, method: "GET" });
  }

  return writeRouteTypes({ appRoot, pages, apis });
}
