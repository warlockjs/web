import { Response, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";
import type { PageDataBundle } from "./execute-page-request.types";

/**
 * Covers the second half of the validation collapse (5.9.0, `a64f852`):
 * a page's `validation = { params, query }` builds ONE schema and runs
 * ONE `v.validate` call (`execute-page-request.ts:188-214`). These specs
 * drive that path directly through `executePageRequest` rather than through
 * `resolveValidationData` (the legacy `{ schema, validating }` shape) or
 * `resolvePageValidationInput` (a unit test of the resolver alone) — neither
 * proves the two schemas are actually merged into a single validation pass
 * whose failure carries BOTH a params error and a query error together.
 */

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

function createHttp(params: Record<string, string>, query: Record<string, string>) {
  let validatedData: Record<string, unknown> = {};
  const response = new Response();
  const request = {
    nonce: undefined,
    locale: "en",
    params,
    query,
    setValidatedData(data: Record<string, unknown>) {
      validatedData = data;
    },
    validated() {
      return validatedData;
    },
  } as unknown as Request;

  return { request, response };
}

function pageEntry(loaderSpy: (validated: unknown) => void): PageRouteEntry {
  return {
    path: "/orders/:id",
    name: "orders.details",
    triple: {
      app: {},
      layout: {},
      page: {
        route: { path: "/orders/:id" },
        validation: {
          params: v.object({ id: v.int().coerce() }),
          query: v.object({ page: v.int().coerce() }),
        },
        loader: ({ request }) => {
          const validated = request.validated();
          loaderSpy(validated);
          return validated;
        },
      },
    },
  };
}

async function run(params: Record<string, string>, query: Record<string, string>) {
  const loaderSpy: unknown[] = [];
  const { request, response } = createHttp(params, query);

  const bundle = (await executePageRequest({
    url: `/orders/${params.id ?? ""}?${new URLSearchParams(query).toString()}`,
    routes: [pageEntry((validated) => loaderSpy.push(validated))],
    createHttp: () => ({ request, response }),
  })) as PageDataBundle;

  return { bundle, loaderSpy };
}

describe("page validation — params + query, one schema, one pass", () => {
  it("both valid: no shortCircuit, and the loader receives coerced params + query", async () => {
    const { bundle, loaderSpy } = await run({ id: "42" }, { page: "3" });

    expect(bundle.shortCircuit).toBeUndefined();
    expect(loaderSpy).toHaveLength(1);
    expect(loaderSpy[0]).toEqual({ params: { id: 42 }, query: { page: 3 } });
  });

  it("params AND query both invalid: exactly one 400 shortCircuit carrying both errors", async () => {
    const { bundle, loaderSpy } = await run({ id: "not-a-number" }, { page: "also-not-a-number" });

    expect(loaderSpy).toHaveLength(0);
    expect(bundle.shortCircuit).toBeDefined();
    expect(bundle.shortCircuit).toMatchObject({ stage: "validation", status: 400 });

    // Actual shape (`{ input: "params.id" | "query.page" }`), confirmed by
    // running this spec once with a diagnostic `console.log` before writing
    // the assertions below.
    const errors = (bundle.shortCircuit as { errors: { input: string }[] }).errors;
    const paramsError = errors.find((issue) => issue.input.includes("id"));
    const queryError = errors.find((issue) => issue.input.includes("page"));

    expect(paramsError).toBeDefined();
    expect(queryError).toBeDefined();
  });

  it("only query invalid: 400 with a query error and no params error", async () => {
    const { bundle, loaderSpy } = await run({ id: "42" }, { page: "not-a-number" });

    expect(loaderSpy).toHaveLength(0);
    expect(bundle.shortCircuit).toBeDefined();
    expect(bundle.shortCircuit).toMatchObject({ stage: "validation", status: 400 });

    const errors = (bundle.shortCircuit as { errors: { input: string }[] }).errors;
    const paramsError = errors.find((issue) => issue.input.includes("id"));
    const queryError = errors.find((issue) => issue.input.includes("page"));

    expect(queryError).toBeDefined();
    expect(paramsError).toBeUndefined();
  });
});
