// Case 8: a page reaching a module that marks ITSELF server-only, one hop
// away, so the refusal has to name the chain rather than the page's own
// import.
import { secretish } from "./case8-helper";

export const route = { path: "/blog/server-only" };

export default function BlogPage() {
  return secretish();
}
