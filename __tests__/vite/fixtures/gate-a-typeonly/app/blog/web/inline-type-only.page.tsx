// POSITIVE case. The exact form measured in
// `design/marker-blast-radius-2026-08-23.md` §2.2 as reaching `resolveId`
// under `verbatimModuleSyntax: true`, and the form 6 of the 8 real
// `@warlock.js/core` imports in `v5/example-app` are written in.
//
// It carries NO value binding: `Request` is erased by the type system, so this
// statement can contribute nothing to the browser. Rule 2 must not refuse it.
import { type Request } from "@warlock.js/core";

export default function BlogPage({ request }: { request: Request }) {
  return `inline-type-only-page:${request.url}`;
}
