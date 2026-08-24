// SCOPE CONTROL. A type-only import whose specifier is refused by rule 3 (the
// `.server` file-name rule), not rule 2. The carve-out is rule 2 only, so this
// must still fail — with rule 3's message, not rule 2's.
import { type CoreRepo } from "./repo.server";

export default function BlogPage({ repo }: { repo: CoreRepo }) {
  return `type-only-server-file-page:${repo.name}`;
}
