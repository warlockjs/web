// NEGATIVE CONTROL. `import "P"` is exactly what esbuild emits for an erased
// inline-type import, so this is the form the carve-out is most at risk of
// swallowing. It is a deliberate runtime edge and must still fail.
import "@warlock.js/core";

export default function BlogPage() {
  return "bare-side-effect-page";
}
