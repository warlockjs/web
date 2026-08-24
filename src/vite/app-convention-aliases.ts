import path from "node:path";

/**
 * One entry of Vite's array-form `resolve.alias`.
 *
 * Declared structurally rather than imported from `vite` so this module has no
 * dependency on the optional peer: it is read by the dev server's bootstrap and
 * by the production build contribution, and neither should pull Vite in merely
 * to learn what the app-convention aliases are.
 */
export type AppConventionAlias = {
  find: RegExp;
  replacement: string;
};

/**
 * The app-tree import convention — `web/*` and `app/*` — expressed as Vite
 * aliases.
 *
 * These mirror the `paths` an application's own `tsconfig.json` declares. Vite
 * does not read tsconfig `paths` on its own, and no `vite-tsconfig-paths`
 * plugin is installed in this workspace, so every pipeline that resolves app
 * source has to be told about them explicitly.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT TWO LITERALS
 *
 * It used to be two literals. The dev server had them; the production build did
 * not — it passed `options.aliases ?? {}` — so `warlock dev` resolved
 * `web/components/...` and the production client build died on the first page
 * it met:
 *
 *     [vite]: Rollup failed to resolve import "web/components/checkbox-input"
 *
 * Dev worked and production could not build at all, for as long as nobody ran
 * the production client build to completion. Copying the pair to a second call
 * site would have fixed that instance and guaranteed the next one, so there is
 * exactly one definition and both pipelines read it.
 *
 * @param appSrcRoot Absolute path to the application's source root — the
 *   directory holding `web/` and `app/`. Both callers default it to
 *   `<appRoot>/src`.
 */
export function appConventionAliases(appSrcRoot: string): AppConventionAlias[] {
  return [
    { find: /^web\//, replacement: `${path.join(appSrcRoot, "web")}/` },
    { find: /^app\//, replacement: `${path.join(appSrcRoot, "app")}/` },
  ];
}
