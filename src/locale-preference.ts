/** Browser-safe locale-switch wire contract shared by web client and server. */
export const LOCALE_PREFERENCE_COOKIE_NAME = "warlock.locale-preference";

/** A data request which must not persist the legacy HttpOnly locale cookie. */
export const PROVISIONAL_LOCALE_REQUEST_HEADER = "x-warlock-locale-provisional";
