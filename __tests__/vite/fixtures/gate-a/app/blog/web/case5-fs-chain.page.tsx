// Case 5: page → helper.ts → node:fs, a 2-hop transitive chain — must fail,
// chain must show both hops.
import { readConfig } from "./fs-helper";

export const route = { path: "/blog" };

export default function BlogPage() {
  return readConfig("/etc/warlock.json");
}
