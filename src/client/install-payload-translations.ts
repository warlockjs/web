import { extend, type Keywords } from "@mongez/localization";
import type { HydrationDocumentPayloadSource } from "../hydration-payload";

const scopedSnapshots = new WeakMap<object, Readonly<Keywords>>();

function copyKeywords(keywords: Readonly<Keywords>): Keywords {
  const copy = Object.create(null) as Keywords;

  for (const [key, value] of Object.entries(keywords)) {
    copy[key] = typeof value === "string" ? value : copyKeywords(value as Readonly<Keywords>);
  }

  return Object.freeze(copy);
}

/**
 * Return one immutable, payload-owned copy of a scoped JSON snapshot. The
 * WeakMap keeps rerenders from cloning it while allowing superseded payloads
 * to be collected.
 */
export function scopedPayloadTranslations(
  payload: HydrationDocumentPayloadSource,
): Readonly<Keywords> | undefined {
  if (payload.translationMode !== "scoped") return undefined;

  const cached = scopedSnapshots.get(payload);
  if (cached !== undefined) return cached;

  const snapshot = copyKeywords(payload.translations);
  scopedSnapshots.set(payload, snapshot);

  return snapshot;
}

/**
 * Install a payload's `translations` into `@mongez/localization`'s
 * process-global table for `payload.locale` — the one action every client
 * render of a payload must take before anything reads that table.
 *
 * `hydrate-page.tsx`'s initial hydration and `build-hydrated-tree.ts`'s
 * `buildHydratedTree` (navigation, `refresh()`, `changeLocaleCode()`, and the
 * initial hydration tree alike) both need this done before `registerModules`
 * runs and before the dev-only completeness assertion reads the table —
 * `build-hydration-payload.ts`'s `translations` key already carries the
 * server's full locale table, so a page/layout `register()` hook was never
 * the only way to get a keyword registered; it is one contributor among
 * several, this being the one every payload carries unconditionally.
 */
export function installPayloadTranslations(payload: HydrationDocumentPayloadSource): void {
  if (payload.translationMode === "scoped") return;

  extend(payload.locale, payload.translations);
}
