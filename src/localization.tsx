import {
  transFrom,
  type Converter,
  type Translatable,
} from "@mongez/localization";
import { createContext, useCallback, useContext, type ReactNode } from "react";

export type LocaleProviderProps = {
  readonly locale: string;
  readonly children: ReactNode;
};

export type Translate = (
  keyword: Translatable,
  placeholders?: unknown,
  converter?: Converter,
) => ReturnType<typeof transFrom>;

const LocaleContext = createContext<string | undefined>(undefined);

/** Bind translations to the request locale carried by the hydration payload. */
export function LocaleProvider({ locale, children }: LocaleProviderProps) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** Read the locale selected for the current server render or client page. */
export function useLocale(): string {
  const locale = useContext(LocaleContext);

  if (locale === undefined) {
    throw new Error(
      "useLocale() was called outside Warlock's LocaleProvider. Render the component " +
        "through the @warlock.js/web page pipeline.",
    );
  }

  return locale;
}

/** Translate without consulting @mongez/localization's process-global locale. */
export function useTrans(): Translate {
  const locale = useLocale();

  return useCallback(
    (keyword, placeholders, converter) =>
      transFrom(locale, keyword, placeholders, converter),
    [locale],
  );
}
