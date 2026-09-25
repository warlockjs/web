// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Returns `value` only when it is a same-origin relative path; otherwise
 * `undefined`. Rejects protocol-relative (`//evil`), backslash (`/\evil`),
 * absolute and `javascript:` targets, and anything with control characters.
 */
export function safeRedirectTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  if (CONTROL_CHARACTERS.test(value)) return undefined;

  if (!value.startsWith("/")) return undefined;

  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;

  return value;
}
