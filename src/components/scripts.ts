import type { ReactElement } from "react";

export type ScriptsProps = {
  /** Per-request CSP nonce for the inline payload script (App.tsx:119). */
  nonce?: string;
};

/**
 * OPTIONAL placement override for the serialized payload (every loader's data
 * + `shared`, escaped) and the hydration modules. Written when placement
 * genuinely matters — a CSP nonce, or ordering against the app's own scripts.
 */
export function Scripts(_props: ScriptsProps): ReactElement {
  throw new Error("@warlock.js/web is not implemented yet");
}
