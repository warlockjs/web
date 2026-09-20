import { SitemapLayoutDeclarationError } from "./errors";
import type { SitemapPageExport, SitemapPageOptions } from "./sitemap-page-export";

/**
 * What a LAYOUT may declare — `false` to exclude its whole subtree, or static
 * options its descendants inherit.
 *
 * Deliberately NARROWER than {@link SitemapPageExport}: a page may also supply
 * its URLs with a function, and a layout may not. A layout states policy; it
 * does not produce data.
 *
 * Both positions are read the same way, off the module. Accepting fewer values
 * in one position is an ordinary, documented difference, the same way `prefix`
 * is layout-only.
 */
export type LayoutSitemapDeclaration = false | SitemapPageOptions;

/**
 * Every key a sitemap options object may carry, taken from the page-level
 * contract rather than invented here — one list, so a layout cannot accept a
 * key a page rejects.
 *
 * An unknown key is REFUSED by name. A setting that is accepted and then never
 * read is indistinguishable from one that works, which is the same silence as
 * a guard that abstains rather than fails.
 */
const CHANGE_FREQS = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLastmod(value: unknown): value is string | Date {
  return (
    (typeof value === "string" && value.trim() !== "") ||
    (value instanceof Date && !Number.isNaN(value.getTime()))
  );
}

const SITEMAP_OPTION_VALIDATORS = {
  priority: (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  changefreq: (value: unknown) => typeof value === "string" && CHANGE_FREQS.includes(value),
  lastmod: isLastmod,
  locales: (value: unknown) => value === false,
  localePaths: (value: unknown) =>
    isPlainObject(value) &&
    Object.entries(value).every(([locale, path]) => locale.length > 0 && typeof path === "string"),
} satisfies Record<keyof SitemapPageOptions, (value: unknown) => boolean>;

const SITEMAP_OPTION_KEYS = Object.keys(SITEMAP_OPTION_VALIDATORS) as (keyof SitemapPageOptions)[];

/**
 * Narrows and validates one layout's declaration.
 *
 * `sourceFile` is for the message only — a developer who has just written an
 * unsupported declaration needs to be told which file to open, not what shape
 * was expected in the abstract.
 */
export function readLayoutSitemapDeclaration(
  declared: unknown,
  sourceFile: string,
): LayoutSitemapDeclaration | undefined {
  if (declared === undefined) return undefined;

  if (declared === false) return false;

  if (typeof declared === "function") {
    throw new SitemapLayoutDeclarationError(
      sourceFile,
      "it is a function. A URL supplier belongs on a page: a layout states policy for the pages beneath it, it does not produce their URLs. Move the supplier to the page, or declare `false` or static options here.",
    );
  }

  if (declared === true) {
    throw new SitemapLayoutDeclarationError(
      sourceFile,
      "it is `true`, which would mean nothing — a layout can exclude its pages with `false` or give them defaults with an object, but it cannot add a page that is not already routable.",
    );
  }

  if (!isPlainObject(declared)) {
    throw new SitemapLayoutDeclarationError(
      sourceFile,
      `it is ${Array.isArray(declared) ? "an array" : typeof declared}. Declare \`false\` or a plain options object.`,
    );
  }

  const unknownKeys = Object.keys(declared).filter(
    (key) => !(SITEMAP_OPTION_KEYS as readonly string[]).includes(key),
  );

  if (unknownKeys.length > 0) {
    throw new SitemapLayoutDeclarationError(
      sourceFile,
      `it carries ${unknownKeys.map((key) => `\`${key}\``).join(", ")}, which the sitemap does not read. Valid options: ${SITEMAP_OPTION_KEYS.join(", ")}.`,
    );
  }

  for (const key of SITEMAP_OPTION_KEYS) {
    const value = declared[key];

    if (value !== undefined && !SITEMAP_OPTION_VALIDATORS[key](value)) {
      throw new SitemapLayoutDeclarationError(
        sourceFile,
        `option \`${key}\` has an invalid value.`,
      );
    }
  }

  return declared as SitemapPageOptions;
}

/** One layout on a page's path, outermost first, with whatever it declared. */
export type LayoutSitemapSource = {
  sourceFile: string;
  /** The layout module's `sitemap` export, untyped — this module is where its shape is trusted. */
  declared: unknown;
};

/**
 * The sitemap declaration that applies to a page, after inheritance.
 *
 * Precedence, per contract §2:
 *
 * 1. the page's own `sitemap`, WHOLESALE — not merged into any inherited
 *    default. A merged value is one no single file states, and the first
 *    question when an entry is wrong is "where did this come from?". Wholesale
 *    override answers that with a filename; merging answers it with a
 *    derivation.
 * 2. otherwise the NEAREST ancestor layout that declared one — the more
 *    specific statement, the same way a nearer `prefix` is.
 * 3. otherwise nothing, and the page behaves exactly as it does today.
 *
 * `layouts` is outermost-first, matching the chain `discoverPages` already
 * builds, so "nearest" is the last one that declared.
 */
export function resolveSitemapDeclaration(
  pageDeclared: unknown,
  layouts: readonly LayoutSitemapSource[],
): SitemapPageExport | undefined {
  let nearest: LayoutSitemapDeclaration | undefined;

  for (const layout of layouts) {
    const declaration = readLayoutSitemapDeclaration(layout.declared, layout.sourceFile);

    if (declaration !== undefined) nearest = declaration;
  }

  if (pageDeclared !== undefined) return pageDeclared as SitemapPageExport;

  return nearest;
}
