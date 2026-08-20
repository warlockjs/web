// Composed pipeline — case 2 (negative control): the default-exported
// component (not `loader`) imports @warlock.js/core directly. Projection
// never touches component-level code, so Gate A must still REFUSE this
// build — proving projection doesn't over-strip and silently defeat Gate A.
import { database } from "@warlock.js/core";

export const loader = async () => {
  return { title: "static" };
};

export default function BlogPage() {
  return database;
}
