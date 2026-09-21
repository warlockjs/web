import type { Keywords } from "@mongez/localization";
import { createHash } from "node:crypto";

import type { RouteLocaleManifest } from "../build/build-route-locale-manifest";

/**
 * The immutable locale table selected for one server render. It is deliberately
 * independent of @mongez/localization's process-wide registry.
 */
export type RouteTranslations = {
  readonly locale: string;
  readonly keywords: Readonly<Keywords>;
  /** Selected copy identity used to keep cached responses current after JSON edits. */
  readonly revision: string;
};

export type RouteTranslationsResolver = (sourceFile: string, locale: string) => RouteTranslations;

function copyAndFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;

  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) copy[key] = copyAndFreeze(child);

  return Object.freeze(copy);
}

/**
 * Makes request-local translation snapshots from the static route-locale
 * manifest. No manifest means the existing, registry-backed localization mode
 * remains in force. Snapshots are cached by source and locale so one request
 * can hand the same immutable identity to its document and payload paths.
 */
export function createRouteTranslationsResolver(
  manifest: RouteLocaleManifest | undefined,
): RouteTranslationsResolver | undefined {
  if (manifest === undefined) return undefined;

  const snapshots = new Map<string, RouteTranslations>();

  return (sourceFile, locale) => {
    const page = manifest.pages[sourceFile];
    if (page === undefined) {
      throw new Error(
        `Route translations have no manifest entry for source ${JSON.stringify(sourceFile)}.`,
      );
    }

    const keywords = page.translationsByLocale[locale];
    if (keywords === undefined) {
      throw new Error(
        `Route translations for source ${JSON.stringify(sourceFile)} have no locale ${JSON.stringify(locale)}.`,
      );
    }

    const key = `${sourceFile}\u0000${locale}`;
    const existing = snapshots.get(key);
    if (existing !== undefined) return existing;

    const snapshot: RouteTranslations = Object.freeze({
      locale,
      keywords: copyAndFreeze(keywords) as Readonly<Keywords>,
      revision: createHash("sha256").update(JSON.stringify(keywords)).digest("hex"),
    });
    snapshots.set(key, snapshot);

    return snapshot;
  };
}
