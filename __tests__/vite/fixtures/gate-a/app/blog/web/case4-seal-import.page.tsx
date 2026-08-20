// Case 4: a page importing @warlock.js/seal for a schema — must pass (seal is universal).
//
// Imports the validator class directly rather than through the `v` factory
// or the package barrel: `@warlock.js/seal`'s `src/index.ts` does
// `export * from "./validators"`, which re-exports EVERY validator — ES
// module `export *` fully evaluates that barrel regardless of which single
// name a consumer actually imports. That barrel includes `StringValidator`,
// which pulls in `net` (rules/string/ip.ts via primitive-validator.ts's
// rules barrel) — a genuine, pre-existing leak in seal's own module graph,
// unrelated to Gate A, and out of scope for @warlock.js/web to fix.
// `AnyValidator` is the only validator whose full import graph (verified:
// `grep -rn 'from "net"|"fs"|"crypto"|"path"|"os"|"node:'` across
// `seal/src` — one hit, ip.ts) carries no Node builtins, so importing it
// DIRECTLY (bypassing every barrel) fixture-tests Gate A's "seal is
// universal, do not over-refuse" rule without tripping over that unrelated
// issue. See the D.1 worker report for this finding.
import { AnyValidator } from "@warlock.js/seal/validators/any-validator";

export const route = { path: "/blog" };

const anySchema = new AnyValidator();

export default function BlogPage() {
  return anySchema;
}
