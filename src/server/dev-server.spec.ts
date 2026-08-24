/**
 * The dev error transport, proved end to end against a REAL vite dev server in
 * the same mount shape `./web-connector.ts` uses: `appType: "custom"`,
 * `middlewareMode: true`, and the connect stack driven with an explicit `next`
 * that stands in for the framework's own routing.
 *
 * A mock vite would prove nothing here. The entire defect lives in vite's
 * middleware ORDERING — its error handler runs last, logs, and calls `next()`
 * with the error cleared when it is in middleware mode
 * (`node_modules/vite/dist/node/chunks/config.js:9525-9527`, mounted at
 * `:25705`) — so the only thing worth asserting is what the real stack does.
 *
 * The `next` fallback in `bootHarness` reproduces what the app actually
 * answered with before this fix: v5/app declares a catch-all page
 * (`v5/app/src/app/main/web/not-found.page.tsx:12`, `path: "*"`), so a refused
 * module URL fell through vite into that route, `renderPageRequest` matched
 * nothing and returned `{ html: "", status: 404 }`
 * (`./render-page.ts:604`), and `./create-page-route-handler.ts:147` wrote it
 * as an empty `text/html` body. Verbatim, from a live server:
 *
 *     HTTP/1.1 404 Not Found
 *     content-type: text/html
 *     content-length: 0
 */
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { buildErrorMessage, createServer, type Plugin, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import { ProjectionAmbiguityError } from "../vite/projection";
import {
  DEV_TRANSFORM_ERROR_STATUS,
  DevErrorTransportInProductionError,
  devErrorTransportPlugin,
  formatDevTransformError,
  sendCapturedDevError,
} from "./dev-server";

/**
 * The refusal under test — a REAL gate error, not a stand-in `new Error()`.
 * Its message is the one the browser has to end up carrying, so the assertions
 * below quote it rather than checking that the body is merely non-empty.
 */
const refusal = () =>
  new ProjectionAmbiguityError(
    "src/web/root.tsx",
    'import "./locales";',
    8,
    "a bare side-effect import with no recognized client-safe asset extension",
    "move it behind a *.server.ts file, a loader, or a controller",
  );

type Harness = {
  url: string;
  loggedToTerminal: string[];
  close: () => Promise<void>;
};

/**
 * A real vite dev server mounted exactly as the connector mounts it.
 *
 * @param transport when absent, NOTHING captures the error — this is the
 *        "today" configuration and it is what the red assertion runs against.
 */
async function bootHarness(
  options: {
    transport?: { isProductionRuntime: () => boolean };
  } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "warlock-dev-error-transport-"));

  await fs.writeFile(path.join(root, "refused.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "allowed.ts"), "export const ok = 2;\n", "utf8");

  const gate: Plugin = {
    name: "test:refusing-gate",
    transform(_code, id) {
      if (id.includes("refused")) throw refusal();

      return null;
    },
  };

  const loggedToTerminal: string[] = [];

  const vite: ViteDevServer = await createServer({
    root,
    configFile: false,
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, watch: null },
    // Proves the fix does not STEAL the failure from vite: the transport
    // captures and re-throws, so vite's own handler still logs it.
    customLogger: {
      info: () => undefined,
      warn: () => undefined,
      warnOnce: () => undefined,
      error: message => loggedToTerminal.push(message),
      clearScreen: () => undefined,
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    plugins: options.transport
      ? [devErrorTransportPlugin({ ...options.transport, buildErrorMessage }), gate]
      : [gate],
  });

  const server = http.createServer((request, response) => {
    vite.middlewares(request, response, () => {
      if (options.transport && sendCapturedDevError(request, response)) return;

      // The framework's own answer for a URL it does not know — see the file
      // header for where this shape comes from.
      response.statusCode = 404;
      response.setHeader("content-type", "text/html");
      response.end("");
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    loggedToTerminal,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await vite.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("dev error transport", () => {
  it("today, without the transport, a refused module answers with an empty 404", async () => {
    const harness = await bootHarness();

    try {
      const response = await fetch(`${harness.url}/refused.ts`);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(body).toBe("");
      // The reason existed the whole time — it just never left the process.
      expect(harness.loggedToTerminal.join("\n")).toContain("Projection refused to guess");
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("carries the gate's own message to the browser", async () => {
    const harness = await bootHarness({ transport: { isProductionRuntime: () => false } });

    try {
      const response = await fetch(`${harness.url}/refused.ts`);
      const body = await response.text();

      expect(response.status).toBe(DEV_TRANSFORM_ERROR_STATUS);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");

      // The message text itself, field by field — a non-empty body would pass
      // even if the transport shipped the wrong error.
      expect(body).toContain("ProjectionAmbiguityError");
      expect(body).toContain("Projection refused to guess");
      expect(body).toContain("File: src/web/root.tsx:8");
      expect(body).toContain('Statement: import "./locales";');
      expect(body).toContain(
        "Cause: a bare side-effect import with no recognized client-safe asset extension",
      );
      // vite's own formatting is reused, so the plugin that refused is named.
      expect(body).toContain("test:refusing-gate");
      // ...and reused WITHOUT the terminal colouring leaking into the body.
      expect(body).not.toContain("[");

      // The terminal message and the overlay push are untouched: vite's error
      // handler still ran, because the transport re-throws after capturing.
      expect(harness.loggedToTerminal.join("\n")).toContain("Projection refused to guess");
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("leaves a module the gate allows completely alone", async () => {
    const harness = await bootHarness({ transport: { isProductionRuntime: () => false } });

    try {
      const response = await fetch(`${harness.url}/allowed.ts`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("const ok = 2");
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("is inert while the process is hosting production — no detail, same refusal", async () => {
    // Constructed in dev (as `boot()` does), then the hosting mode flips. The
    // per-request re-check is what this proves: the transport must not hold a
    // leak open on a boot-time reading.
    let productionRuntime = false;

    const harness = await bootHarness({
      transport: { isProductionRuntime: () => productionRuntime },
    });

    try {
      productionRuntime = true;

      const response = await fetch(`${harness.url}/refused.ts`);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(body).toBe("");
      expect(body).not.toContain("ProjectionAmbiguityError");
      expect(body).not.toContain("root.tsx");
      expect(body).not.toContain(os.tmpdir());
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("refuses to be constructed at all on a production-hosted process", () => {
    expect(() => devErrorTransportPlugin({ isProductionRuntime: () => true, buildErrorMessage })).toThrow(
      DevErrorTransportInProductionError,
    );
  });
});

describe("formatDevTransformError", () => {
  it("leads with the error's name and message", () => {
    const body = formatDevTransformError(refusal(), buildErrorMessage);

    expect(body.startsWith("ProjectionAmbiguityError: Projection refused to guess")).toBe(true);
  });

  it("walks the cause chain vite does not walk", () => {
    const inner = new Error("Unexpected token, expected \";\"");
    inner.name = "SyntaxError";

    const outer = new Error("Gate B refused a module", { cause: inner });
    outer.name = "SecretsLeakError";

    const body = formatDevTransformError(outer, buildErrorMessage);

    expect(body).toContain("SecretsLeakError: Gate B refused a module");
    expect(body).toContain('Caused by: SyntaxError: Unexpected token, expected ";"');
  });

  it("accepts a thrown non-Error without losing it", () => {
    expect(formatDevTransformError("a plugin threw a string", buildErrorMessage)).toContain(
      "a plugin threw a string",
    );
  });
});
