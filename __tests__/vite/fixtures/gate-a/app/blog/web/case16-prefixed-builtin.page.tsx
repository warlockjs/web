// Case 16: the same app source, the same builtin, the `node:` spelling — and
// imported DIRECTLY by the page rather than through the helper hop case 5
// takes. Both spellings must refuse identically.
import { readFileSync } from "node:fs";

export const route = { path: "/blog/prefixed-builtin" };

export default function BlogPage() {
  return readFileSync("/etc/warlock.json", "utf-8");
}
