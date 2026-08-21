/**
 * Test double for CORE's request context that is not a double of the mechanics:
 * core's `RequestContext.run` IS the inherited `Context.run`
 * (context/src/base-context.ts:83-85 — a straight delegate to
 * `AsyncLocalStorage.run`; the subclass at
 * core/src/http/context/request-context.ts:21-62 declares only
 * getRequest/getResponse/getUser/buildStore, no `run` override). Web cannot
 * import core here — no core dep, no built esm (see
 * implementation/2026-08-20-A3-shared-proxy.md §2) — so this subclass extends
 * the SAME base class core extends, over core's store shape
 * (`{ request, response }`, request-context.ts:10-13): the isolation specs
 * execute the very `run` function core executes per request.
 */
import { Context } from "../../../context/src/base-context";
import type { SharedStore } from "../../src/shared";

export type TestStore = SharedStore & {
  request: unknown;
  response: { parse(value: unknown): Promise<unknown> };
};

export class TestRequestContext extends Context<TestStore> {
  public buildStore(payload?: Record<string, any>): TestStore {
    return {
      request: payload?.request,
      response: payload?.response,
    };
  }
}

/**
 * A `response` stub whose `parse` reproduces core's `Response.parse`
 * semantics exactly where the seal depends on them
 * (core/src/http/response.ts:297-331): scalars returned as-is (:299), toJSON
 * resolved FIRST and its result never re-parsed (:301-305), iterables mapped
 * (:308-316), and — the load-bearing part — plain objects mutated IN PLACE
 * (:324-330), which is what forces parse to run before freeze (canon 26c64f9a).
 */
export function makeParsingResponse(): TestStore["response"] {
  async function parse(value: any): Promise<any> {
    if (!value || typeof value !== "object") return value;

    if (typeof value.toJSON === "function") return await value.toJSON();

    if (Array.isArray(value)) {
      return Promise.all(value.map(item => parse(item)));
    }

    for (const key in value) {
      value[key] = await parse(value[key]);
    }

    return value;
  }

  return { parse };
}

export function makeStore(request: unknown = { id: "req" }): TestStore {
  return {
    request,
    response: makeParsingResponse(),
  };
}
