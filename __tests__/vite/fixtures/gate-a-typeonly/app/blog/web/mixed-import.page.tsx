// NEGATIVE CONTROL. A type-only import of the package sitting BESIDE a value
// import of the same package. `resolveId` is called once for the specifier, so
// the classification has to be per-FILE and "value" has to win the merge —
// otherwise the type-only line launders the value line.
import { type Request } from "@warlock.js/core";
import { config } from "@warlock.js/core";

export default function BlogPage({ request }: { request: Request }) {
  return `mixed-import-page:${config}:${request.url}`;
}
