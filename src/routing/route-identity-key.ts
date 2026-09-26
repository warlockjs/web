/**
 * The one comparison key for "do these two pages answer the same URL?" —
 * discovery, the dev installer and the production manifest installer all
 * detect duplicate routes through it, so `/blog/:id` and `/blog/:slug` collide
 * in all three rather than only at build.
 *
 * Parameter names are normalised to a positional marker; a trailing `?`, `*`
 * or `+` stays attached, so optional and wildcard params remain distinct from
 * required ones. `site` and `method` are prefixed only when present, so a
 * single-site, method-less key is the bare normalised path.
 *
 * Pure string logic — see the directory contract in `route-identity.ts`.
 */
export function routeIdentityKey(input: { site?: string; method?: string; path: string }): string {
  const shape = input.path.replace(/(^|\/):[^/?*+]+/g, "$1:_");
  const prefix = [input.site, input.method].filter((part) => part !== undefined).join(" ");

  return prefix === "" ? shape : `${prefix} ${shape}`;
}
