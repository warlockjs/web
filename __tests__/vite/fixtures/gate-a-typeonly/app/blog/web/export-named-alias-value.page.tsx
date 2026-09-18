// NEGATIVE CONTROL. Identical shape to `export-named-alias-type-only.page.tsx`
// — a re-export specifier carrying an ALIAS — but the binding is a real VALUE.
// The alias must not launder a value re-export into looking type-only.
export { config as coreConfig } from "@warlock.js/core";

export default function BlogPage() {
  return "export-named-alias-value-page";
}
