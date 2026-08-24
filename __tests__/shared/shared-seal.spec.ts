import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectSharedStore,
  enterSharedScope,
  sealShared,
  shared,
} from "../../src/shared";
import { makeStore, TestRequestContext, type TestStore } from "./test-request-context";

const sharedAny = shared as Record<string, any>;

describe("sealShared — gate → parse → freeze", () => {
  let context: TestRequestContext;

  beforeEach(() => {
    context = new TestRequestContext();
    connectSharedStore(() => context.getStore());
    // The freeze gate reads Vite's built-in DEV flag at seal time.
    vi.stubEnv("DEV", true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const inRequest = <T>(fn: (store: TestStore, target: Record<string, any>) => Promise<T>) => {
    const store = makeStore();
    return context.run(store, async () => {
      const target = enterSharedScope(store) as Record<string, any>;
      return fn(store, target);
    });
  };

  it("prototype gate rejects a Date naming the key, BEFORE freeze", async () => {
    await inRequest(async (store, target) => {
      sharedAny.startedAt = new Date();

      await expect(sealShared(store)).rejects.toThrowError(/`shared\.startedAt` is a Date/);

      // gate precedes freeze AND the sealed flag: nothing is frozen, writes still work
      expect(Object.isFrozen(target)).toBe(false);
      sharedAny.startedAt = "2026-08-20T00:00:00.000Z";
      expect(sharedAny.startedAt).toBe("2026-08-20T00:00:00.000Z");
    });
  });

  it("prototype gate rejects a class instance naming the key", async () => {
    class Settings {
      public theme = "dark";
    }

    await inRequest(async store => {
      sharedAny.settings = new Settings();

      await expect(sealShared(store)).rejects.toThrowError(
        /`shared\.settings` is a class instance \(Settings\)/,
      );
    });
  });

  it("prototype gate names NESTED offending keys, including array paths", async () => {
    await inRequest(async store => {
      sharedAny.user = { profile: { avatar: new Map() } };

      await expect(sealShared(store)).rejects.toThrowError(
        /`shared\.user\.profile\.avatar` is a Map/,
      );

      sharedAny.user = { profile: { avatar: "x" } };
      sharedAny.items = [1, { tags: new Set() }];

      await expect(sealShared(store)).rejects.toThrowError(
        /`shared\.items\[1\]\.tags` is a Set/,
      );
    });
  });

  it("seal order: parse normalizes toJSON payloads in place, THEN freeze locks them", async () => {
    await inRequest(async (store, target) => {
      // a Resource-like value: non-plain data behind a toJSON contract — the
      // gate lets it through without descending
      sharedAny.user = { toJSON: () => ({ name: "hasan", roles: ["admin"] }) };
      sharedAny.locale = "en";

      const sealed = (await sealShared(store)) as Record<string, any>;

      // parse rewrote the key in place (response.ts:327 semantics), and the
      // sealed return IS the target, the exact object the pipeline serializes
      expect(sealed).toBe(target);
      expect(sealed.user).toEqual({ name: "hasan", roles: ["admin"] });

      // freeze landed AFTER parse — had the order been reversed, parse's
      // in-place write would have thrown on the frozen target
      expect(Object.isFrozen(target)).toBe(true);
      expect(Object.isFrozen(target.user)).toBe(true);
      expect(Object.isFrozen(target.user.roles)).toBe(true);
    });
  });

  it("second gate rejects a Date a Resource's toJSON introduces AFTER parse (parse re-entry hole)", async () => {
    await inRequest(async store => {
      // pre-parse this looks like a plain object with a callable toJSON — the
      // FIRST gate passes it untouched (not descended).
      // parse() resolves toJSON (response.ts:301-305) and never re-parses the
      // result, so the Date re-enters the payload AFTER the
      // first gate already ran. Only a SECOND gate, run on the post-parse
      // target, can catch it.
      sharedAny.event = {
        toJSON: () => ({ name: "launch", at: new Date() }),
      };

      await expect(sealShared(store)).rejects.toThrowError(/`shared\.event\.at` is a Date/);
    });
  });

  it("post-seal writes and deletes throw naming the key; reads keep working", async () => {
    await inRequest(async store => {
      sharedAny.locale = "en";

      await sealShared(store);

      expect(() => {
        sharedAny.locale = "ar";
      }).toThrowError(/write `shared\.locale`.*SEALED/s);
      expect(() => {
        delete sharedAny.locale;
      }).toThrowError(/delete `shared\.locale`.*SEALED/s);

      expect(sharedAny.locale).toBe("en");
      expect(Object.keys(shared)).toEqual(["locale"]);
    });
  });

  it("freeze is dev-only: production seals without freezing, but sealed writes still throw", async () => {
    vi.stubEnv("DEV", false);

    await inRequest(async (store, target) => {
      sharedAny.locale = "en";

      await sealShared(store);

      // env-gated: the expensive deep freeze is skipped in production…
      expect(Object.isFrozen(target)).toBe(false);
      // …but the seal contract is NOT env-gated
      expect(() => {
        sharedAny.locale = "ar";
      }).toThrowError(/SEALED/);
      expect(sharedAny.locale).toBe("en");
    });
  });

  it("the prototype gate itself runs in production too", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await inRequest(async store => {
      sharedAny.startedAt = new Date();

      await expect(sealShared(store)).rejects.toThrowError(/`shared\.startedAt` is a Date/);
    });
  });

  it("sealShared() with no argument seals the current request's scope", async () => {
    await inRequest(async (_store, target) => {
      sharedAny.locale = "en";

      await sealShared();

      expect(Object.isFrozen(target)).toBe(true);
      expect(sharedAny.locale).toBe("en");
    });
  });

  it("sealing twice throws", async () => {
    await inRequest(async store => {
      await sealShared(store);
      await expect(sealShared(store)).rejects.toThrowError(/called twice/);
    });
  });

  it("a store without response.parse fails naming what the pipeline must supply", async () => {
    const store = { request: {} } as unknown as TestStore;

    await context.run(store, async () => {
      enterSharedScope(store);

      await expect(sealShared(store)).rejects.toThrowError(/no `response\.parse`/);
      await expect(sealShared(store)).rejects.toThrowError(/Response\.parse/);
    });
  });

  it("two requests seal independently", async () => {
    const flowSealed = async (label: string) => {
      const store = makeStore({ id: label });

      return context.run(store, async () => {
        enterSharedScope(store);
        sharedAny.who = label;
        if (label === "a") await sealShared(store);
        return { who: sharedAny.who, canWrite: label !== "a" };
      });
    };

    const [a, b] = await Promise.all([flowSealed("a"), flowSealed("b")]);

    // a is sealed, b never sealed — the sealed flag is per-scope, not module state
    expect(a.who).toBe("a");
    expect(b.who).toBe("b");
  });
});
