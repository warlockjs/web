/**
 * The single `\` → `/` rule every path-normalising call site in this package
 * routes through, so a Windows path and its POSIX equivalent always compare
 * equal.
 */
export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
