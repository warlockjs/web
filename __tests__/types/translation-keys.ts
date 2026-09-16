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
