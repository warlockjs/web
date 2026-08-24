// The other type-only spelling — `import type { … }` as a statement modifier.
// This form is erased by esbuild WITHOUT `verbatimModuleSyntax` too, so it
// normally never reaches Gate A at all; under this fixture's tsconfig it does,
// which makes it the cheapest available check that both spellings are read.
import type { Response } from "@warlock.js/core";

export default function BlogPage({ response }: { response: Response }) {
  return `statement-type-only-page:${response.status}`;
}
