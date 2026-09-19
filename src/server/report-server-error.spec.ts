import config from "@mongez/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  droppedServerErrorReportCount,
  flushPendingServerErrorReports,
  pendingServerErrorReportCount,
  reportServerError,
  resetServerErrorReportingStateForTests,
} from "./report-server-error";
import type { ServerErrorContext } from "./error-reporting-config";

const baseContext: ServerErrorContext = {
  kind: "render",
  phase: "render",
  pathname: "/posts/42",
  method: "GET",
  routeName: "posts.show",
  routePath: "/posts/:slug",
  requestId: "req-1",
};

function setReporter(
  report: ((error: unknown, context: ServerErrorContext) => unknown) | undefined,
) {
  config.set("web", report === undefined ? {} : { errors: { report } });
}

describe("reportServerError()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetServerErrorReportingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetServerErrorReportingStateForTests();
    setReporter(undefined);
  });

  it("always writes the unconditional console floor, even with no reporter configured", () => {
    setReporter(undefined);

    reportServerError("boom happened", new Error("boom"), baseContext);

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[warlock:web] boom happened:", expect.any(Error));
  });

  it("never awaits the reporter — the call returns before the reporter's promise settles", async () => {
    let resolveReport!: () => void;
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReport = resolve;
        }),
    );
    setReporter(report);

    reportServerError("boom", new Error("boom"), baseContext);

    // Synchronous return — the reporter has not even started yet (it runs on
    // a microtask), which is the fire-and-forget contract itself.
    expect(report).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    resolveReport();
  });

  it("one report per failure class — render, loader, and defer each dispatch their own call", async () => {
    const report = vi.fn();
    setReporter(report);

    reportServerError("render failed", new Error("render"), { ...baseContext, kind: "render" });
    reportServerError("loader failed", new Error("loader"), { ...baseContext, kind: "loader" });
    reportServerError("defer failed", new Error("defer"), { ...baseContext, kind: "defer" });

    await Promise.resolve();
    await Promise.resolve();

    expect(report).toHaveBeenCalledTimes(3);
    expect(report.mock.calls.map(([, context]) => (context as ServerErrorContext).kind)).toEqual([
      "render",
      "loader",
      "defer",
    ]);
  });

  it("dedupes the same Error object reported twice (render + defer overlap) into one app-hook call", async () => {
    const report = vi.fn();
    setReporter(report);
    const sharedError = new Error("shared failure");

    reportServerError("render observed it", sharedError, { ...baseContext, kind: "render" });
    reportServerError("defer observed it too", sharedError, { ...baseContext, kind: "defer" });

    await Promise.resolve();
    await Promise.resolve();

    // The console floor still logs BOTH distinct messages — dedupe only
    // scopes the app-hook dispatch, never the unconditional floor.
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("red control: two DIFFERENT error objects with identical content are never deduped", async () => {
    const report = vi.fn();
    setReporter(report);

    reportServerError("first", new Error("same message"), baseContext);
    reportServerError("second", new Error("same message"), baseContext);

    await Promise.resolve();
    await Promise.resolve();

    // Proves dedupe keys on OBJECT IDENTITY, not message content — if it keyed
    // on content instead, this would wrongly collapse to one call too.
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing reporter: logs once, never recurses, and never leaks an unhandled rejection", async () => {
    const report = vi.fn(() => {
      throw new Error("reporter is broken");
    });
    setReporter(report);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    reportServerError("boom", new Error("boom"), baseContext);

    await Promise.resolve();
    await Promise.resolve();
    process.off("unhandledRejection", unhandled);

    expect(report).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[warlock:web] web.errors.report() threw or rejected; the report was not retried:",
      expect.any(Error),
    );

    // A LATER, distinct failure still reaches the (still-broken) reporter —
    // the earlier throw did not permanently disable dispatch.
    reportServerError("boom again", new Error("boom again"), baseContext);
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("isolates a rejecting reporter the same way as a throwing one", async () => {
    const report = vi.fn(() => Promise.reject(new Error("nope")));
    setReporter(report);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    reportServerError("boom", new Error("boom"), baseContext);

    // A REJECTING reporter needs an extra tick beyond a throwing one: the
    // `.then()` handler returns the rejected promise, and promise adoption
    // itself costs a microtask before `.catch()` ever runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[warlock:web] web.errors.report() threw or rejected; the report was not retried:",
      expect.any(Error),
    );
  });

  it("bounds the queue and drops the OLDEST pending report when full", () => {
    // Every reporter call here hangs forever, so nothing self-removes from
    // the pending set — the exact condition under which the bound matters.
    const pendingPromises: Array<() => void> = [];
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pendingPromises.push(resolve);
        }),
    );
    setReporter(report);

    for (let index = 0; index < 100; index++) {
      reportServerError(`failure ${index}`, new Error(`failure ${index}`), baseContext);
    }

    expect(pendingServerErrorReportCount()).toBe(100);
    expect(droppedServerErrorReportCount()).toBe(0);

    // The 101st report must drop the OLDEST, never the newest, and count it.
    reportServerError("failure 100", new Error("failure 100"), baseContext);

    expect(pendingServerErrorReportCount()).toBe(100);
    expect(droppedServerErrorReportCount()).toBe(1);

    for (const resolve of pendingPromises) resolve();
  });

  it("shutdown flush awaits every pending report", async () => {
    let resolveReport!: () => void;
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReport = resolve;
        }),
    );
    setReporter(report);

    reportServerError("boom", new Error("boom"), baseContext);
    await Promise.resolve();
    expect(pendingServerErrorReportCount()).toBe(1);

    const flushing = flushPendingServerErrorReports(2000);
    resolveReport();
    await flushing;

    expect(pendingServerErrorReportCount()).toBe(0);
  });

  it("shutdown flush is capped — it returns even if a reporter never settles", async () => {
    const report = vi.fn(() => new Promise<void>(() => undefined));
    setReporter(report);

    reportServerError("boom", new Error("boom"), baseContext);
    await Promise.resolve();

    const startedAt = Date.now();
    await flushPendingServerErrorReports(30);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("does nothing when no reporter is configured, even after a failure", async () => {
    setReporter(undefined);

    reportServerError("boom", new Error("boom"), baseContext);
    await Promise.resolve();

    expect(pendingServerErrorReportCount()).toBe(0);
  });
});
