import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateRouteTypes, type RegisteredRouteTypeSnapshot } from "./generate-route-types";

const ROUTE_TYPES_RELATIVE_PATH = ".warlock/typings/web-routes.d.ts";

/** The final registered page/API snapshots used to write app-local route declarations. */
export type WriteRouteTypesInput = {
  readonly appRoot: string;
  readonly pages: readonly RegisteredRouteTypeSnapshot[];
  readonly apis: readonly RegisteredRouteTypeSnapshot[];
};

/** The target and whether this invocation replaced its contents. */
export type WriteRouteTypesResult = {
  readonly path: string;
  readonly changed: boolean;
};

async function currentContent(target: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(target, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
}

/**
 * Atomically replace the app-owned declaration file only when generated content
 * changes. The temporary sibling is unique to this invocation and is removed
 * if writing or replacement fails.
 */
export async function writeRouteTypes({
  appRoot,
  pages,
  apis,
}: WriteRouteTypesInput): Promise<WriteRouteTypesResult> {
  const target = path.join(appRoot, ROUTE_TYPES_RELATIVE_PATH);
  const content = generateRouteTypes({ pages, apiRoutes: apis });

  if ((await currentContent(target)) === content) return { path: target, changed: false };

  const directory = path.dirname(target);
  const temporary = path.join(directory, `.web-routes.${randomUUID()}.tmp`);

  await fs.promises.mkdir(directory, { recursive: true });

  try {
    await fs.promises.writeFile(temporary, content, "utf-8");
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }

  return { path: target, changed: true };
}
