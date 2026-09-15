/** The two text directions a locale can resolve to. */
export type TextDirection = "rtl" | "ltr";

/**
 * Unicode script subtags (lowercased) whose writing system reads
 * right-to-left. Consulted only when `Intl.Locale`'s own text info is
 * unavailable, and consulted BEFORE the language table below so an explicit
 * script subtag always wins over the base language (`az-Arab` is rtl even
 * though `az` alone is not; `ku-Latn` is ltr even though `ckb` — a different
 * Kurdish variant — is).
 */
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "syrc", "nkoo", "adlm", "rohg"]);

/**
 * ISO 639 language subtags (lowercased) that read right-to-left when no
 * script subtag is present to override them.
 */
const RTL_LANGUAGES = new Set(["ar", "he", "iw", "fa", "ur", "ps", "dv", "sd", "ug", "yi", "ckb"]);

/**
 * Read `direction` off whatever shape of Intl.Locale text info the current
 * runtime exposes: the `getTextInfo()` method (newer runtimes) or the
 * `textInfo` property (older ones). Returns `undefined` when neither is
 * present, throws, or returns something unrecognized, so the caller can fall
 * back to the script/language table without ever throwing itself.
 */
function readIntlTextDirection(locale: Intl.Locale): TextDirection | undefined {
  try {
    const withTextInfo = locale as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };

    const info =
      typeof withTextInfo.getTextInfo === "function"
        ? withTextInfo.getTextInfo()
        : withTextInfo.textInfo;

    if (info?.direction === "rtl" || info?.direction === "ltr") {
      return info.direction;
    }
  } catch {
    // Fall through to the script/language table.
  }

  return undefined;
}

/**
 * Resolve direction from the parsed locale's script and language subtags
 * when `Intl.Locale` cannot answer directly. An explicit script subtag is
 * checked first and, if present, decides the outcome on its own.
 */
function readTableDirection(locale: Intl.Locale): TextDirection {
  const script = locale.script?.toLowerCase();

  if (script) {
    return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  }

  const language = locale.language?.toLowerCase();

  return language !== undefined && RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * Resolve the text direction ("rtl" or "ltr") for a BCP 47 locale tag.
 *
 * Pure and side-effect free, and used identically on the server and in the
 * client — it never reads global or ambient locale state, only its argument.
 * Prefers `Intl.Locale`'s own text info when the runtime provides it, and
 * otherwise falls back to a script/language table. Never throws: invalid
 * input (including an empty string) resolves to `"ltr"`.
 */
export function localeDirection(locale: string): TextDirection {
  let parsed: Intl.Locale;

  try {
    parsed = new Intl.Locale(locale);
  } catch {
    return "ltr";
  }

  return readIntlTextDirection(parsed) ?? readTableDirection(parsed);
}
