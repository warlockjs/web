// Case 19 (NEGATIVE CONTROL): an ungoverned third-party package that touches
// no builtin still builds. Cases 17 and 18 must be refusals about the
// SPECIFIER, not a blanket suspicion of node_modules.
import { vendorBrowserValue } from "vendor-browser-lib";

export const route = { path: "/blog/vendor-safe" };

export default function BlogPage() {
  return vendorBrowserValue;
}
