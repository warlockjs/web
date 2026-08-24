// Sits in the module's own web/ folder and imports nothing forbidden by any
// path-shaped rule — the ONLY thing making it server-only is that it says so.
import "server-only";

export function secretish() {
  return "server-side value";
}
