import { beforeEach, describe, expect, it } from "vitest";
import {
  connectSharedStore,
  enterSharedScope,
  shared,
  useShared,
} from "../../src/shared";
import { makeStore, TestRequestContext } from "./test-request-context";

/**
 * `shared` is app-augmented and ships empty; the specs write through an
 * untyped view, which is exactly what an augmenting app's declared keys
 * compile to.
 */
const sharedAny = shared as Record<string, any>;

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("shared proxy — ALS forwarding", () => {
  let context: TestRequestContext;

  beforeEach(() => {
    context = new TestRequestContext();
    connectSharedStore(() => context.getStore());
  });

  it("forwards reads and writes to the current request's target", async () => {
    const store = makeStore();

    await context.run(store, async () => {
      const target = enterSharedScope(store) as Record<string, any>;

      sharedAny.locale = "en";
      sharedAny.user = { name: "hasan" };

      // the proxy and the raw target are the same storage, not a copy
      expect(target.locale).toBe("en");
      expect(sharedAny.locale).toBe("en");
      expect(sharedAny.user).toEqual({ name: "hasan" });

      // useShared() is the same live view, not a snapshot
      const view = useShared() as Record<string, any>;
      expect(view.locale).toBe("en");
      sharedAny.locale = "ar";
      expect(view.locale).toBe("ar");
    });
  });

  it("forwards has/delete/ownKeys to the current request's target", async () => {
    const store = makeStore();

    await context.run(store, async () => {
      enterSharedScope(store);

      sharedAny.flag = true;
      sharedAny.gone = 1;

      expect("flag" in shared).toBe(true);
      delete sharedAny.gone;
      expect("gone" in shared).toBe(false);
      expect(Object.keys(shared)).toEqual(["flag"]);
      expect({ ...sharedAny }).toEqual({ flag: true });
    });
  });

  it("two concurrent scopes are fully isolated across await boundaries", async () => {
    // Two interleaved "requests" through core's real store.run (see
    // test-request-context.ts header): each writes its own payload, yields the
    // event loop so the other runs in between, then reads back.
    const flow = async (label: string) => {
      const store = makeStore({ id: label });

      return context.run(store, async () => {
        enterSharedScope(store);

        sharedAny.payload = `payload-for-${label}`;
        await tick();

        sharedAny.locale = label === "a" ? "en" : "ar";
        await tick();

        return { payload: sharedAny.payload, locale: sharedAny.locale };
      });
    };

    const [a, b] = await Promise.all([flow("a"), flow("b")]);

    expect(a.payload).toBe("payload-for-a");
    expect(a.locale).toBe("en");
    expect(b.payload).toBe("payload-for-b");
    expect(b.locale).toBe("ar");
  });

  it("a late access after another request entered still sees its own scope", async () => {
    // Heavier interleaving: each flow appends across three await boundaries;
    // any caching of a resolved target bleeds one flow's writes into the other.
    const flow = async (label: string) => {
      const store = makeStore({ id: label });

      return context.run(store, async () => {
        enterSharedScope(store);
        sharedAny.entries = [] as string[];

        for (let i = 0; i < 3; i++) {
          await tick();
          sharedAny.entries = [...sharedAny.entries, `${label}:${i}`];
        }

        return sharedAny.entries;
      });
    };

    const [a, b] = await Promise.all([flow("a"), flow("b")]);

    expect(a).toEqual(["a:0", "a:1", "a:2"]);
    expect(b).toEqual(["b:0", "b:1", "b:2"]);
  });

  it("read outside any request context throws the named error", () => {
    expect(() => sharedAny.locale).toThrowError(
      /read `shared\.locale`.*outside a request context/s,
    );
    // the error names the fix, not just the failure
    expect(() => sharedAny.locale).toThrowError(/middleware, a loader, a component render/);
  });

  it("write outside any request context throws the named error", () => {
    expect(() => {
      sharedAny.locale = "en";
    }).toThrowError(/write `shared\.locale`.*outside a request context/s);

    expect(() => useShared()).toThrowError(/outside a request context/);
  });

  it("access inside a request before enterSharedScope names the fix", async () => {
    const store = makeStore();

    await context.run(store, async () => {
      expect(() => sharedAny.locale).toThrowError(/no `shared` scope yet/);
      expect(() => sharedAny.locale).toThrowError(/enterSharedScope/);
    });
  });

  it("entering the same store's scope twice throws", async () => {
    const store = makeStore();

    await context.run(store, async () => {
      enterSharedScope(store);
      expect(() => enterSharedScope(store)).toThrowError(/called twice/);
    });
  });
});
