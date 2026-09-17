import { localeDirection } from "../../text-direction";

/**
 * Make `document.documentElement`'s `lang`/`dir` describe the locale now on
 * screen.
 *
 * ## Why this exists
 *
 * The server render sets `<html lang dir>` from the request's resolved
 * locale (`components/default-app.tsx:25`, or an app's own `root.tsx`
 * following the same rule). But `root.tsx` sits OUTSIDE the hydrated
 * subtree — the browser hydrates `#vessel`, not the document
 * (`skills/write-the-root/SKILL.md`) — so no client render, including one
 * produced by {@link changeLocaleCode} or a plain navigation, can ever reach
 * it. Left alone, `useLocale()`/`useTextDirection()` update in-page while
 * `documentElement.lang`/`dir` keep whatever the last full load set, until
 * the next one.
 *
 * This is the imperative correction, the same shape `applyDocumentMetadata`
 * already uses for `<head>` and for the same reason. Pure and side-effect
 * free given its arguments, and used identically for a `changeLocaleCode`
 * swap, an ordinary navigation, and a refresh — the caller decides WHEN to
 * call it; this only decides WHAT to write.
 *
 * Writes are skipped when already correct, so a swap that does not change
 * locale costs nothing beyond the read.
 */
export function syncDocumentLocale(documentNode: Document, locale: string): void {
  const root = documentNode.documentElement;

  if (root.lang !== locale) {
    root.lang = locale;
  }

  const direction = localeDirection(locale);

  if (root.dir !== direction) {
    root.dir = direction;
  }
}
