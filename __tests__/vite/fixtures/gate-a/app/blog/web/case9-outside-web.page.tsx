// Case 9: rule 4 — a local module outside this module's web/ folder that is
// not a recognized universal surface. Nothing about this rule is a "missing
// marker", so it must be untouched by the fail-open flip.
//
// The specifier carries its extension on purpose: Gate A judges the path it
// derives itself from the RAW specifier (`resolveId` runs before anything
// appends an extension), and rule 4 only judges code-carrying files
// (`LOCAL_MODULE_EXTENSIONS`, gate-a-resolve.ts:175). An extensionless
// `../services/outside-helper` therefore slips rule 4 entirely — a
// pre-existing gap, unrelated to this slice and deliberately not widened here.
import { outsideHelper } from "../services/outside-helper.ts";

export const route = { path: "/blog/outside" };

export default function BlogPage() {
  return outsideHelper();
}
