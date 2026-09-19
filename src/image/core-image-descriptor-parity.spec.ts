import type { GeneratedImageDescriptor } from "@warlock.js/core";
import { describe, expectTypeOf, it } from "vitest";
import type { ImageDescriptor } from "./types";

/**
 * Core's `generateImageVariants` returns `GeneratedImageDescriptor`
 * (`core/src/http/uploads/image-variant-types.ts`) and `<Image>` takes
 * `ImageDescriptor` (`web/src/image/types.ts`). The two types are kept in
 * sync by comment only, field for field, so nothing forces them to stay
 * compatible when either side changes.
 *
 * This assertion fails typecheck the moment core's output shape stops being
 * assignable to what `<Image>` accepts — e.g. a renamed/removed field, or a
 * narrower `formats`/`urls` value type on core's side than web's.
 */
describe("GeneratedImageDescriptor / ImageDescriptor parity", () => {
  it("keeps core's generateImageVariants output assignable to <Image>'s prop type", () => {
    expectTypeOf<GeneratedImageDescriptor>().toExtend<ImageDescriptor>();
  });
});
