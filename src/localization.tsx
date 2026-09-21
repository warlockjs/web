import {
  transFrom,
  transFromKeywords,
  type Converter,
  type Keywords,
  type Translatable,
} from "@mongez/localization";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { TranslationKey } from "./index";
import { recordCurrentLocale } from "./routing/current-locale";

export type LocaleProviderProps = {
  readonly locale: string;
  /** A selected-locale snapshot that must stay independent of the global registry. */
  readonly translations?: Readonly<Keywords>;
  readonly children: ReactNode;
};

export type Translate = (
  keyword: TranslationKey | Exclude<Translatable, string>,
  placeholders?: unknown,
  converter?: Converter,
) => ReturnType<typeof transFrom>;

type LocaleValue = {
  readonly locale: string;
  readonly translations?: Readonly<Keywords>;
};

const LocaleContext = createContext<LocaleValue | undefined>(undefined);

/**
 * Bind translations to the request locale carried by the hydration payload.
 *
 * Also records `locale` for `<Link>`'s locale-prefixing seam
 * (`routing/current-locale.ts`) — see that module's header for why this is
 * the one place that recording belongs, rather than a hook `<Link>` would
 * have to call. `recordCurrentLocale` is a no-op on the server: the server
 * reads the REQUEST's locale off the per-request ALS store instead, never a
 * value this component wrote, because two concurrent requests both
 * rendering a `LocaleProvider` must never share one process-wide slot.
 */
export function LocaleProvider({ locale, translations, children }: LocaleProviderProps) {
  recordCurrentLocale(locale);

  return (
    <LocaleContext.Provider value={{ locale, translations }}>{children}</LocaleContext.Provider>
  );
}

/** Read the locale selected for the current server render or client page. */
export function useLocale(): string {
  const value = useContext(LocaleContext);

  if (value === undefined) {
    throw new Error(
      "useLocale() was called outside Warlock's LocaleProvider. Render the component " +
        "through the @warlock.js/web page pipeline.",
    );
  }

  return value.locale;
}

/** Translate without consulting @mongez/localization's process-global locale. */
export function useTrans(): Translate {
  const value = useContext(LocaleContext);

  if (value === undefined) {
    throw new Error(
      "useTrans() was called outside Warlock's LocaleProvider. Render the component " +
        "through the @warlock.js/web page pipeline.",
    );
  }

  const { locale, translations } = value;

  return useCallback(
    (keyword, placeholders, converter) =>
      translations === undefined
        ? transFrom(locale, keyword, placeholders, converter)
        : transFromKeywords(locale, translations, keyword, placeholders, converter),
    [locale, translations],
  );
}
