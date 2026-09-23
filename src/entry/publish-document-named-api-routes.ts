import { parse } from "devalue";
import { parseNamedApiRoutes, publishNamedApiRoutes } from "../routing/named-api-routes";

export const NAMED_API_ROUTES_SCRIPT_ID = "__WARLOCK_NAMED_API_ROUTES__";

/** Reads the optional server route snapshot without making hydration depend on it. */
export function publishDocumentNamedApiRoutes(documentNode: Document = document): void {
  const node = documentNode.getElementById(NAMED_API_ROUTES_SCRIPT_ID);
  if (node === null) return;
  try {
    const routes = parseNamedApiRoutes(parse(node.textContent ?? ""));
    if (routes === undefined)
      console.warn("Warlock named API route metadata is unavailable; use an explicit API path.");
    publishNamedApiRoutes(routes);
  } catch {
    publishNamedApiRoutes(undefined);
    console.warn("Warlock named API route metadata could not be read; use an explicit API path.");
  }
}
