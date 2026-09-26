import { describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import { registerTlsAsk } from "./register-tls-ask";

describe("registerTlsAsk", () => {
  it("registers a non-page GET route that sends the ask status with an empty body", async () => {
    let registered:
      | {
          path: string;
          handler: (context: { request: { query: Record<string, unknown> }; response: { send: ReturnType<typeof vi.fn> } }) => Promise<void>;
          options: unknown;
        }
      | undefined;
    const router = {
      get(path: string, handler: never, options: unknown) {
        registered = { path, handler: handler as never, options };
      },
    } as unknown as Router;

    registerTlsAsk(router, {
      tlsAsk: "/.well-known/warlock/domain",
      sites: { tenant: { pages: "(tenant)", dynamic: true } },
      resolveHost: async () => ({ site: "tenant", key: "acme" }),
    });

    expect(registered?.path).toBe("/.well-known/warlock/domain");
    expect(registered?.options).toBeUndefined();

    const send = vi.fn();
    await registered?.handler({ request: { query: { domain: "acme.test" } }, response: { send } });
    expect(send).toHaveBeenCalledWith("", 200);
  });
});
