// Composed pipeline — case 1 (positive): `loader` imports @warlock.js/core
// directly; the default-exported component does NOT. Projection must strip
// `loader` (and the now-orphaned `database` import) before Gate A's
// resolveId ever runs, so the composed build must SUCCEED.
import { database } from "@warlock.js/core";

export const loader = async () => {
  return { title: await database.find() };
};

export default function BlogPage() {
  return "blog page";
}
