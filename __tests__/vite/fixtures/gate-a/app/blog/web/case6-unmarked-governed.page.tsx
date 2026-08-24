// Case 6: the `@mongez/react-atom` shape — a governed-scope package with NO
// `warlock.environment` marker. Absent information is no longer a refusal.
import { unmarkedPkgValue } from "@mongez/unmarked-pkg";

export const route = { path: "/blog/unmarked" };

export default function BlogPage() {
  return unmarkedPkgValue;
}
