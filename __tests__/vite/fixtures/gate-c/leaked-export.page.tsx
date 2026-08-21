// Gate C bypass fixture (Part 1, item 3): built with ONLY gateCVerify() in
// the plugin array — projection is deliberately absent, so `route` is never
// stripped. Gate C alone must still catch it in the EMITTED bundle.
export const route = { path: "/leaked" };

export default function LeakedExportPage() {
  return "leaked export page";
}
