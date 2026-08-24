// Case 13: the monorepo-sibling shape — a governed package resolved to a
// directory outside the app root whose internals sit under `web/src/server/`.
// Same protection as case 12, reached by a different resolution path.
import { siblingServerValue } from "@warlock.js/sibling-web";

export const route = { path: "/blog/sibling-server-dir" };

export default function BlogPage() {
  return siblingServerValue;
}
