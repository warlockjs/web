// Case 3: a page importing a sibling universal helper — must pass.
import { formatTitle } from "./helper";

export const route = { path: "/blog" };

export default function BlogPage() {
  return formatTitle("Blog");
}
