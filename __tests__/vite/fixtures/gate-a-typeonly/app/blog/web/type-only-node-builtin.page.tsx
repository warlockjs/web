// SCOPE CONTROL. A type-only import of a Node builtin. Rule 1 is not exempted,
// so this must still fail.
import { type Stats } from "node:fs";

export default function BlogPage({ stats }: { stats: Stats }) {
  return `type-only-node-builtin-page:${stats.size}`;
}
