// POSITIVE case. The exact form that reaches `resolveId`
// under `verbatimModuleSyntax: true` — 6 of the 8 real
// `@warlock.js/core` imports in `v5/example-app` are written this way.
//
// It carries NO value binding: `Request` is erased by the type system, so this
// statement can contribute nothing to the browser. Rule 2 must not refuse it.
import { type Request } from "@warlock.js/core";

export default function BlogPage({ request }: { request: Request }) {
  return `inline-type-only-page:${request.url}`;
}
