// Compiled alone by tsconfig.with-generation.json: a `declare module` augmentation is
// global to its TS program and would leak into translation-keys-without-generation.ts.
import { useTrans } from "@warlock.js/web";

declare module "@warlock.js/web" {
  interface TranslationKeyRegistry {
    "products.notFound": true;
  }
}

const translate = useTrans();

translate("products.notFound");

// @ts-expect-error Registered translations must reject misspelled keys.
translate("products.notFoud");
