/**
 * `@warlock.js/web/vite` — build-tooling subpath, kept separate from the
 * runtime barrel (`@warlock.js/web`) so importing it never pulls `vite` into
 * a project that doesn't build with Vite.
 */
import type { Plugin } from "vite";
import { gateAResolve } from "./gate-a-resolve";
import { gateBSecrets } from "./gate-b-secrets";
import { projection } from "./projection";

export { gateAResolve } from "./gate-a-resolve";
export { gateBSecrets } from "./gate-b-secrets";
export { projection, ProjectionAmbiguityError } from "./projection";
export type { ProjectionResult } from "./projection";

/**
 * The composed client-build pipeline (canon `c604f0bc` §2-7): projection
 * strips the 5 server exports first, THEN Gate B's `transform` checks
 * whatever source remains for inline secret reads, THEN Gate A's
 * `resolveId` judges whatever imports remain. Array order here is
 * `[projection(), gateBSecrets(), gateAResolve()]` to match Vite's own
 * pipeline shape (`transform` before `resolveId`), but array order alone
 * does not guarantee this — see the hook-ordering fact below, which is what
 * actually makes the composition correct.
 *
 * Empirically observed fact (via an instrumented real `vite.build()`, not
 * assumed from plugin array order): for a given module M, Vite/Rollup calls
 * `transform(M)` BEFORE it calls `resolveId` for any of M's own import
 * specifiers — because Rollup must parse M's post-transform source to even
 * discover which specifiers to resolve next. Concretely: `transform` ran on
 * `entry.page.tsx` first, and only after that did `resolveId("./dep", ...)`
 * fire for the import statement still present in the transformed code. A
 * consequence follows directly: if projection's `transform` removes an
 * import statement from a page module entirely (e.g. `loader`'s
 * `@warlock.js/core` import, stripped because `loader` itself is removed),
 * `resolveId` is never invoked for that specifier at all — Gate A doesn't
 * "let it pass", it never sees it. Gate A's `resolveId` only fires for
 * imports that survive projection's `transform`, which is exactly why a
 * component-level `@warlock.js/core` import (never touched by projection)
 * still reaches and is refused by Gate A.
 *
 * This is OBSERVED Rollup behavior, not a documented contract (Suki, room
 * seq 546 pt.3) — a future Vite/Rollup upgrade could invert it. Pinned by a
 * regression test (`index.spec.ts`, "D.3 hook ordering pin") that fails
 * loudly if the ordering ever inverts, and by the `vite` peer floor in
 * `web/package.json` (`>=7.3.5`, the version this was verified against). If
 * that test ever fails after a Vite bump: the failure mode of the ordering
 * assumption breaking is SAFE — projection would stop removing an import
 * statement Gate A still sees, so Gate A would refuse an import it used to
 * silently let a stripped server export take with it. That is a loud build
 * failure ("Gate A refused an import"), never a silent client-bundle leak.
 * Do NOT "fix" an apparent Gate A false-positive after a Vite upgrade by
 * weakening Gate A (e.g. widening what it lets through) — investigate
 * whether this ordering assumption broke instead; loosening Gate A to work
 * around it would turn a loud failure into the exact silent leak this
 * pipeline exists to prevent.
 *
 * Gate B is placed between the two for the same reason, but for a `transform`
 * hook rather than `resolveId`: within a plugin array, Rollup runs each
 * module's registered `transform` hooks in array order, each one receiving
 * the PREVIOUS plugin's output. Running Gate B after projection means it
 * inspects the POST-projection source — a `process.env.SECRET` read inside
 * `loader` (a server export, legitimately reading a real secret server-side)
 * is invisible to Gate B once projection has already removed `loader`
 * entirely, exactly as it should be: Gate B's job is to fence client-bound
 * code, and projection is what decides what counts as client-bound. A
 * component-level secret read is untouched by projection and still reaches
 * Gate B, which refuses it. Gate B does not depend on Gate A's `resolveId`
 * output at all (orthogonal concern, raw source vs. import paths), so its
 * position relative to Gate A is not load-bearing — it is placed before Gate
 * A only to keep both `transform` hooks adjacent in the array.
 */
export function warlockClientBoundary(options: Parameters<typeof gateAResolve>[0] = {}): Plugin[] {
  return [projection(), gateBSecrets(), gateAResolve(options)];
}
