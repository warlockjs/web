import type { SharedContext } from "../../../src/index";

/**
 * The fixture's locally-scoped `SharedContext` extension.
 *
 * This is deliberately NOT a `declare module` augmentation of the library's
 * `SharedContext` (`../../../src/index.ts:17`): that form is a *global*
 * declaration merge — once any file carrying it enters the TypeScript
 * program (as it does the moment `streamed-document.parity.spec.ts` imports
 * this fixture tree), the added keys become required on `SharedContext`
 * EVERYWHERE in the compile, including `web/src/shared.ts`'s own
 * `SharedTarget = SharedContext & Record<...>` and unrelated specs that build
 * a bare `{}` shared payload (canon: only the app declares identity, never a
 * test fixture). A fixture needs the same v5/app shape (`base.middleware.ts`)
 * locally, not globally — so this exports a type the fixtures cast `shared`
 * to, instead of mutating the library's own interface.
 */
export type FixtureSharedContext = SharedContext & {
  /** Required — written unconditionally by App's `base` middleware. */
  locale: string;
  /** Required — same writer. */
  appName: string;
  /** Optional — written only when the request carries `?user=`. */
  user?: { name: string };
};
