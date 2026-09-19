import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Response, setEnvironment, type Request } from "@warlock.js/core";
import { configureSeal, getSealConfig, v, type TranslateRuleCallback } from "@warlock.js/seal";
import { serializePageError } from "./error-page";
import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";
import type { PageDataBundle } from "./execute-page-request.types";
import { hydrationErrorPageProps } from "./error-page";
import { PageValidationFailedError } from "./page-validation-failed-error";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("PageValidationFailedError disclosure (card 6781c6f3)", () => {
  it("keeps errors[] (input/type/error only) and a non-generic message in production", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("Page validation failed.");
    expect(serialized.message).not.toBe("An unexpected error occurred.");
    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    expect(serialized).not.toHaveProperty("stack");
  });

  it("never lets a submitted value on the Seal error object reach the output", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      {
        input: "page",
        type: "numeric",
        error: "The page field must be a number.",
        value: "abc",
        secret: "should-never-appear",
      },
    ]);

    const serialized = serializePageError(error);

    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("abc");
    expect(json).not.toContain("should-never-appear");
  });

  it("keeps a generic Error sanitized alongside validation disclosure", () => {
    setEnvironment("production");
    const error = new Error("db password=hunter2");

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("An unexpected error occurred.");
    expect(serialized).not.toHaveProperty("errors");
    expect(serialized).not.toHaveProperty("stack");
  });

  it("agrees between SSR props and the hydration payload for a validation error", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);

    const hydration = hydrationErrorPageProps({ error, status: 400 }, error, "req-1");
    const ssrEquivalent = serializePageError(error, "req-1");

    expect(ssrEquivalent).toEqual(hydration.error);
    expect(hydration.error.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
  });

  it("exposes errors in development too, alongside the stack", () => {
    setEnvironment("development");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    error.stack = "PageValidationFailedError: Page validation failed.\n    at internal.ts:1:1";

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("Page validation failed.");
    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    expect(serialized.stack).toBe(error.stack);
  });
});

/**
 * The real production path goes through `buildErrorRecord` FIRST: it scrubs
 * every non-public error into a generic surrogate before the error page ever
 * serializes it. Calling `serializePageError` directly (above) never saw that
 * scrub — live, a production `/posts?page=abc` showed "An unexpected error
 * occurred." with no issues. These pin the whole chain.
 */
describe("PageValidationFailedError survives the production error record (card 6781c6f3)", () => {
  it("buildErrorRecord keeps the validation error itself, so the error page props carry the issues", async () => {
    setEnvironment("production");
    const { buildErrorRecord } = await import("./settle-page-response");
    const error = new PageValidationFailedError([
      { input: "query.page", type: "number", error: "This input accepts only numbers" },
    ]);

    const record = buildErrorRecord(error, { boundaryLevel: "page" } as never);
    const props = hydrationErrorPageProps({ error: record.error, status: 400 }, record.error);

    expect(record.scrubbed).toBe(false);
    expect(props.error.message).toBe("Page validation failed.");
    expect(props.error.errors).toEqual([
      { input: "query.page", type: "number", error: "This input accepts only numbers" },
    ]);
  });

  it("buildErrorRecord still scrubs an ordinary error in production", async () => {
    setEnvironment("production");
    const { buildErrorRecord } = await import("./settle-page-response");

    const record = buildErrorRecord(new Error("db password is hunter2"), {
      boundaryLevel: "page",
    } as never);

    expect(record.scrubbed).toBe(true);
    expect(String((record.error as Error).message)).not.toContain("hunter2");
  });
});

const HOSTILE = "<script>SECRET-123</script>";

/**
 * Shaped like the starter's `validation.enum` translation
 * (create-warlock templates, `locales.ts`): it echoes `:value`, interpolated
 * from the attributes Seal hands the app's translator. String enums run the
 * `in` rule, scalar enums the `enum` rule.
 */
const starterLikeTranslateRule: TranslateRuleCallback = ({ rule, attributes }) => {
  if (rule.name !== "enum" && rule.name !== "in") return "";

  return ":input must be one of the following values: :values, given value :value.".replace(
    /:([a-zA-Z_]+)/g,
    (match, key: string) => (key in attributes ? String(attributes[key]) : match),
  );
};

function hostileRequest(query: Record<string, string>) {
  const response = new Response();
  const request = {
    nonce: undefined,
    locale: "en",
    params: {},
    query,
    setValidatedData() {},
    validated() {
      return {};
    },
  } as unknown as Request;

  return { request, response };
}

/**
 * Drives the REAL chain a production page-validation 400 takes:
 * `executePageRequest` (Seal validates) → `buildErrorRecord` → the hydration
 * payload `hydrationErrorPageProps` builds from that record.
 */
async function renderValidationFailure(validation: PageRouteEntry["triple"]["page"]["validation"]) {
  const query = { status: HOSTILE };
  const { request, response } = hostileRequest(query);

  const bundle = (await executePageRequest({
    url: `/posts?${new URLSearchParams(query).toString()}`,
    routes: [
      {
        path: "/posts",
        name: "posts",
        triple: { app: {}, layout: {}, page: { route: { path: "/posts" }, validation } },
      },
    ],
    createHttp: () => ({ request, response }),
  })) as PageDataBundle;

  expect(bundle.error).toBeDefined();

  const record = bundle.error!;

  return hydrationErrorPageProps({ error: record.error, status: 400 }, record.error);
}

/**
 * `sanitizeValidationIssues` keeps `issue.error` verbatim, so a translation or
 * author `errorMessage` using `:value` used to interpolate the raw input into
 * the SSR document and the hydration payload. Production now redacts what the
 * `:value` placeholder renders; a custom rule that concatenates raw input into
 * its own message text is not covered and stays the author's responsibility.
 */
describe("page-validation :value placeholder is redacted in production (card 6781c6f3)", () => {
  let previousTranslateRule: TranslateRuleCallback | undefined;

  beforeEach(() => {
    connectPageContext({
      buildStore: (payload) => payload as never,
      getStore: () => undefined,
      run: async (_store, callback) => callback(),
    });
    previousTranslateRule = getSealConfig().translateRule;
    configureSeal({ translateRule: starterLikeTranslateRule });
  });

  afterEach(() => {
    configureSeal({ translateRule: previousTranslateRule });
  });

  it("production: a translation's :value renders the redaction, not the input", async () => {
    setEnvironment("production");

    const props = await renderValidationFailure({
      query: v.object({ status: v.enum(["draft", "published"]) }),
    });
    const [issue] = props.error.errors!;

    expect(issue.error).toContain("given value …");
    expect(issue.error).toContain("draft, published");
    expect(JSON.stringify(props.error.errors)).not.toContain("SECRET-123");
    expect(JSON.stringify(props)).not.toContain("SECRET-123");
  });

  it("production: an author errorMessage's :value renders the redaction, not the input", async () => {
    setEnvironment("production");

    const props = await renderValidationFailure({
      schema: v.object({ status: v.enum(["draft", "published"], "Bad status :value") }),
    });

    expect(props.error.errors).toEqual([{ input: "status", type: "in", error: "Bad status …" }]);
    expect(JSON.stringify(props)).not.toContain("SECRET-123");
  });

  it("development: keeps full diagnostics, so :value still renders the input", async () => {
    setEnvironment("development");

    const props = await renderValidationFailure({
      query: v.object({ status: v.enum(["draft", "published"]) }),
    });

    expect(props.error.errors![0].error).toContain(`given value ${HOSTILE}`);
  });
});
