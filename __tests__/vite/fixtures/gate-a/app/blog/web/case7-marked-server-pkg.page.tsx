// Case 7: a governed-scope package that DECLARES
// `"warlock": { "environment": "server" }` — must still be refused.
import { markedServerValue } from "@warlock.js/marked-server-pkg";

export const route = { path: "/blog/marked" };

export default function BlogPage() {
  return markedServerValue;
}
