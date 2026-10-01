import { describe, expectTypeOf, it } from "vitest";
import type { ReactElement } from "react";
import type { Translate, TranslateFor, TranslationKey } from "./index";
import { useTrans } from "./localization";

/** What an app's generated `.warlock/typings/translations.d.ts` makes of the registry. */
type GeneratedKey = "posts.title" | "posts.empty";

describe("useTrans() public types", () => {
  it("returns the Translate type, never any", () => {
    expectTypeOf(useTrans).returns.toEqualTypeOf<Translate>();
    expectTypeOf<Translate>().not.toBeAny();
  });

  it("returns string when no converter is passed", () => {
    function probe(trans: Translate) {
      expectTypeOf(trans("anything")).toEqualTypeOf<string>();
      expectTypeOf(trans("anything", { name: "Ada" })).toEqualTypeOf<string>();
      expectTypeOf(trans({ en: "Hello", ar: "مرحبا" })).toEqualTypeOf<string>();
      expectTypeOf(trans("anything", {}, undefined)).toEqualTypeOf<string>();
    }

    expectTypeOf(probe).toBeFunction();
  });

  it("returns exactly what an explicit converter returns", () => {
    function probe(trans: Translate) {
      const element = trans("anything", {}, (translation): ReactElement => {
        expectTypeOf(translation).toEqualTypeOf<string>();

        return null as unknown as ReactElement;
      });

      expectTypeOf(element).toEqualTypeOf<ReactElement>();
      expectTypeOf(element).not.toBeAny();

      const length = trans("anything", { count: 2 }, (translation, placeholders) => {
        expectTypeOf(placeholders).toEqualTypeOf<{ count: number }>();

        return translation.length;
      });

      expectTypeOf(length).toEqualTypeOf<number>();
    }

    expectTypeOf(probe).toBeFunction();
  });

  it("falls back to string keys while the registry is empty", () => {
    expectTypeOf<TranslationKey>().toEqualTypeOf<string>();
  });

  it("checks keys against a generated registry and rejects unknown ones", () => {
    function probe(trans: TranslateFor<GeneratedKey>) {
      expectTypeOf(trans("posts.title")).toEqualTypeOf<string>();
      expectTypeOf(trans({ en: "Inline" })).toEqualTypeOf<string>();

      // @ts-expect-error -- "posts.missing" is not in the generated registry
      trans("posts.missing");

      // @ts-expect-error -- unknown keys are rejected on the converter overload too
      trans("posts.missing", {}, (translation) => translation);
    }

    expectTypeOf(probe).toBeFunction();
    expectTypeOf<Parameters<TranslateFor<GeneratedKey>>[0]>().toEqualTypeOf<
      GeneratedKey | { [localeCode: string]: string }
    >();
  });

  it("contextually types a lambda passed where a Translate is expected", () => {
    // The blog's pattern: a helper takes a `Translate`, the caller passes a lambda.
    // An overloaded `Translate` left `key` implicitly `any` here (TS7006).
    function label(translate: Translate): string {
      return translate("posts.title");
    }

    function probe(trans: Translate) {
      expectTypeOf(label((key) => trans(String(key)))).toEqualTypeOf<string>();
      label((key) => {
        expectTypeOf(key).not.toBeAny();

        return trans(key);
      });
    }

    expectTypeOf(probe).toBeFunction();
  });
});
