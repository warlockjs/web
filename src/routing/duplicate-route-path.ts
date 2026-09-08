/**
 * The collision-check wording both page installers raise when two pages
 * compose to the same effective route path — source-agnostic: which page won
 * the race to register first is the only fact either installer's own loop
 * contributes, not where either page's module came from.
 *
 * Names neither installer: an earlier version of this message named
 * `install-page-routes.ts` by path even when production's installer was the
 * one raising it (a cross-citing promise, not a mechanism — see this
 * function's callers for why that class of promise is exactly what this
 * module now replaces). The message is accurate for whichever installer
 * calls it.
 */
export function duplicateRoutePathMessage(input: {
  effectivePath: string;
  existingFile: string;
  newFile: string;
  /** The declared-route composition that produced `effectivePath`, when the colliding page declared one. */
  composition?: { layoutPrefix: string; routePath: string };
}): string {
  const { effectivePath, existingFile, newFile, composition } = input;
  const compositionSuffix =
    composition === undefined
      ? ""
      : ` (layout prefix "${composition.layoutPrefix}" + route.path "${composition.routePath}")`;

  return (
    `composed route path "${effectivePath}"${compositionSuffix} is declared by two pages — ` +
    `"${existingFile}" and "${newFile}". Every page's composed route path must be unique.`
  );
}
