import { describe, expectTypeOf, it } from "vitest";
import type {
  ErrorPageProps,
  SerializedErrorPageProps,
  SerializedPageError,
} from "./index";

describe("ErrorPageProps public contract", () => {
  it("keeps the SSR error value public and exposes a distinct hydration shape", () => {
    expectTypeOf<SerializedPageError>().toEqualTypeOf<{
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    }>();
    expectTypeOf<ErrorPageProps>().toEqualTypeOf<{
      readonly error: unknown;
      readonly status: number;
    }>();
    expectTypeOf<SerializedErrorPageProps>().toEqualTypeOf<{
      readonly error: SerializedPageError;
      readonly status: number;
    }>();
  });
});
