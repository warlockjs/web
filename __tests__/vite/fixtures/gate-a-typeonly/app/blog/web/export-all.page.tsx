// NEGATIVE CONTROL. `export * from "P"` carries no specifier list at all —
// `exportDeclarationKind` reads `stmt.specifiers` for its type-only judgement,
// and an `ExportAllDeclaration` has none. An empty specifier list must still
// classify as a runtime "value" edge (this is a re-export of everything, not
// an erased type import), so this must FAIL exactly like a value import.
export * from "@warlock.js/core";

export default function BlogPage() {
  return "export-all-page";
}
