// Case 17: the app imports an ordinary third-party package by name. The Node
// builtin is TWO hops away, inside that package's own source, and outside every
// governed scope. The app author cannot see it from this file.
import { readVendorConfig } from "vendor-node-lib";

export const route = { path: "/blog/vendor" };

export default function BlogPage() {
  return readVendorConfig("/etc/warlock.json");
}
