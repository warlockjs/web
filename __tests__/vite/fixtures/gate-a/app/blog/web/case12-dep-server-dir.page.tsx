// Case 12: a governed-scope DEPENDENCY whose own internals live under
// `src/server/`, installed at <appRoot>/node_modules. Package-internal
// layout is not app source; this must build.
import { frameworkValue } from "@warlock.js/framework-like";

export const route = { path: "/blog/dep-server-dir" };

export default function BlogPage() {
  return frameworkValue;
}
