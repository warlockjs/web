// Case 15: the app's OWN source importing a builtin by its BARE name. Nothing
// about this file is in a governed scope, and the specifier carries no `node:`
// prefix to pattern-match on — the name has to be recognized as a builtin.
import { readFileSync } from "fs";

export const route = { path: "/blog/bare-builtin" };

export default function BlogPage() {
  return readFileSync("/etc/warlock.json", "utf-8");
}
