/**
 * Logs one `console.error` naming the image's `src` when `alt` is missing.
 * DEV only — `alt` is typed as required, so this catches the untyped call
 * sites (plain JS, or `as any`) TypeScript cannot. Production stays silent:
 * see `shared.ts`'s `import.meta.env?.DEV` note for why the optional
 * chaining here is load-bearing.
 */
export function warnMissingAlt(src: string, alt: string | undefined): void {
  if (import.meta.env?.DEV && alt === undefined) {
    console.error(`<Image> is missing "alt" for "${src}". Pass alt="" for decorative images.`);
  }
}
