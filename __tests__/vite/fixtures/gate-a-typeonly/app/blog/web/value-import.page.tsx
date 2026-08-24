// NEGATIVE CONTROL. Identical to `inline-type-only.page.tsx` in every way that
// is not the point: same page, same directory, same tsconfig, same package.
// The ONLY difference is that `config` is a value binding. This must still
// fail, or the type-only carve-out has disabled rule 2 rather than scoped it.
import { config } from "@warlock.js/core";

export default function BlogPage() {
  return `value-import-page:${config}`;
}
