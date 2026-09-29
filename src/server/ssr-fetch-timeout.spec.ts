import { describe, expect, it, vi } from "vitest";
import {
  resolveSsrFetchTimeoutMs,
  SsrModuleFetchTimeoutError,
  withSsrFetchTimeout,
} from "./ssr-fetch-timeout";

describe("SSR module-fetch timeout", () => {
  it("honours a configured timeout", async () => {
    const error = await withSsrFetchTimeout(
      "/src/web/slow.page.tsx",
      () => new Promise(() => undefined),
      10,
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SsrModuleFetchTimeoutError);
    expect((error as SsrModuleFetchTimeoutError).elapsedMs).toBeGreaterThanOrEqual(10);
  });

  it("names the module, elapsed time, and overload remedy", async () => {
    await expect(
      withSsrFetchTimeout("/src/web/slow.page.tsx", () => new Promise(() => undefined), 10),
    ).rejects.toThrow(/\/src\/web\/slow\.page\.tsx.*\d+ms.*host is likely overloaded.*WARLOCK_SSR_FETCH_TIMEOUT_MS/);
  });

  it("lets the environment override the connector option", () => {
    const previous = process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS;
    process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS = "25";

    expect(resolveSsrFetchTimeoutMs(10)).toBe(25);

    if (previous === undefined) delete process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS;
    else process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS = previous;
  });

  it("warns and falls back for an invalid environment value", () => {
    const previous = process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS;
    process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS = "nope";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveSsrFetchTimeoutMs()).toBe(60_000);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
    if (previous === undefined) delete process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS;
    else process.env.WARLOCK_SSR_FETCH_TIMEOUT_MS = previous;
  });
});
