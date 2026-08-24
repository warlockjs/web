// NEGATIVE CONTROL. A type-only static import beside a DYNAMIC import of the
// same package. Both reach `resolveId` with the same specifier string; the
// runtime one must win.
import { type Request } from "@warlock.js/core";

export default function BlogPage({ request }: { request: Request }) {
  return import("@warlock.js/core").then((core) => `dynamic:${core.config}:${request.url}`);
}
