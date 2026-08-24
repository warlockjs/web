// A value import of a governed package that is NOT marked. Nothing about rule
// 2's permissive default changes, and the import resolves normally — it is not
// erased, because there was never anything to erase it for.
//
// SUBJECT CHANGED 2026-08-24. This fixture used to import `@warlock.js/core`,
// which was then unmarked. Core now declares
// `"warlock": { "environment": "server" }`, so it could no longer stand for
// "an unmarked governed package" — the test failed for the right reason.
//
// `@mongez/supportive-is` is the replacement because it is (a) inside a governed
// scope, so rule 2 actually judges it, (b) genuinely unmarked, and (c) a pure
// predicate library that reaches no Node builtin — otherwise rule 1 would refuse
// it and the case would pass for the wrong reason.
//
// If `@mongez/supportive-is` is ever given a marker, this case must move to
// another unmarked governed package rather than being deleted: what it guards
// is the permissive default, which is what keeps unreleased `@mongez/*` packages
// usable from client code.
import is from "@mongez/supportive-is";

export default function BlogPage({ url }: { url: string }) {
  return `type-only-unmarked-page:${is.string(url)}:core-value-binding`;
}
