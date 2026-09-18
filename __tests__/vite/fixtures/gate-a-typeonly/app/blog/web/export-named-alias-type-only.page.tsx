// POSITIVE case. `export { type X as Y } from "P"` — a type-only RE-EXPORT
// specifier carrying an ALIAS (`exported` differs from `local`). Every
// specifier's own `exportKind` is `"type"`, so the whole statement must be
// erased exactly like an inline `import { type X }`, regardless of the alias.
export { type Request as CoreRequest } from "@warlock.js/core";

export default function BlogPage() {
  return "export-named-alias-type-only-page";
}
