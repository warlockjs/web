import type { Model } from "@warlock.js/cascade";
import type { Response } from "@warlock.js/core";
import { expectTypeOf } from "vitest";
import { defer, type AppProps, type LayoutProps, type PageMetadata, type PageProps } from "@warlock.js/web";

/**
 * What a page reads from its loader is what survived `serializeLoaderData` +
 * devalue, i.e. `Serialized<LoaderReturn, "devalue">`, not the loader's raw
 * return. Runtime parity lives in `src/server/serialize-loader-data.parity.spec.ts`.
 */

interface LoaderDataPostData {
  id: number;
  secret: string;
}

interface LoaderDataPostOutput {
  id: number;
  title: string;
  publishedAt: Date;
}

declare class LoaderDataPostResource {
  toJSON(): LoaderDataPostOutput;
}

declare class LoaderDataPost extends Model<LoaderDataPostData> {}

/** A private member makes it detectable as a class instance; no `toJSON`. */
declare class LoaderDataCounter {
  private count: number;
  label: string;
}

declare module "@warlock.js/core" {
  interface ModelResourceRegistry {
    __WebLoaderDataPost: { model: LoaderDataPost; resource: typeof LoaderDataPostResource };
  }
}

declare const post: LoaderDataPost;
declare const counter: LoaderDataCounter;

// Registered model -> resource output; Date, Map and Set stay native.
const richLoader = async () => ({ post, at: new Date(), map: new Map<string, number>(), set: new Set<Date>() });

expectTypeOf<PageProps<typeof richLoader>["data"]>().toEqualTypeOf<{
  post: LoaderDataPostOutput;
  at: Date;
  map: Map<string, number>;
  set: Set<Date>;
}>();

// Layout, app and metadata read the same serialized data.
expectTypeOf<LayoutProps<typeof richLoader>["data"]["post"]>().toEqualTypeOf<LoaderDataPostOutput>();
expectTypeOf<AppProps<typeof richLoader>["data"]["at"]>().toEqualTypeOf<Date>();

const metadata: PageMetadata<typeof richLoader> = ({ data }) => {
  expectTypeOf(data.post.publishedAt).toEqualTypeOf<Date>();
  return { title: data.post.title };
};
void metadata;

// A class instance without `toJSON` would make devalue throw: `never` for that key.
const counterLoader = async () => ({ counter, ok: "yes" });
expectTypeOf<PageProps<typeof counterLoader>["data"]["counter"]>().toBeNever();
expectTypeOf<PageProps<typeof counterLoader>["data"]["ok"]>().toEqualTypeOf<string>();

// Plain JSON-ish data is the identity, and a function key is dropped.
const plainLoader = async () => ({
  name: "Warlock",
  price: 12,
  tags: ["a", "b"],
  nested: { flag: true, maybe: undefined as string | undefined },
  none: null,
  run: () => 1,
});

expectTypeOf<PageProps<typeof plainLoader>["data"]>().toEqualTypeOf<{
  name: string;
  price: number;
  tags: string[];
  nested: { flag: boolean; maybe: string | undefined };
  none: null;
}>();

// A loader with no return value still reads as `void`/`undefined`, never `never`.
const voidLoader = async () => {};
expectTypeOf<PageProps<typeof voidLoader>["data"]>().toBeVoid();

const arrayLoader = async () => [{ at: new Date() }];
expectTypeOf<PageProps<typeof arrayLoader>["data"]>().toEqualTypeOf<{ at: Date }[]>();

// A core Response is terminal, never data.
const responseLoader = async (): Promise<Response | { id: number }> => ({ id: 1 });
expectTypeOf<PageProps<typeof responseLoader>["data"]>().toEqualTypeOf<{ id: number }>();

// No loader: nothing to read.
expectTypeOf<PageProps["data"]>().toBeUndefined();

// Deferred keys keep their promise; the SETTLED value is serialized.
const deferredLoader = async () =>
  defer({
    post,
    reviews: Promise.resolve([{ at: new Date(), author: post }]),
    total: Promise.resolve(3),
  });

expectTypeOf<PageProps<typeof deferredLoader>["data"]>().toEqualTypeOf<{
  post: LoaderDataPostOutput;
  reviews: Promise<{ at: Date; author: LoaderDataPostOutput }[]>;
  total: Promise<number>;
}>();

const deferredCounterLoader = async () => defer({ late: Promise.resolve(counter) });
expectTypeOf<PageProps<typeof deferredCounterLoader>["data"]["late"]>().toEqualTypeOf<Promise<never>>();

// The loader's own declared return type is untouched.
expectTypeOf<Awaited<ReturnType<typeof richLoader>>["post"]>().toEqualTypeOf<LoaderDataPost>();

// @ts-expect-error The raw model type is not what the page receives.
expectTypeOf<PageProps<typeof richLoader>["data"]["post"]>().toEqualTypeOf<LoaderDataPost>();

