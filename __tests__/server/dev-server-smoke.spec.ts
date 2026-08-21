import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  connectPageRoutes,
  PAYLOAD_SCRIPT_ID,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteMatch,
  type PageRoutesRegistry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import { routes } from "./fixtures/routes";

/**
 * Slice 4a: the SSR pipeline behind a REAL socket. Same P1 fixture and
 * connects as render-page-request.spec.ts, but the document travels over
 * node:http and comes back through global fetch — proving the pipeline's
 * output IS a servable response, byte for byte, per-request isolated.
 */

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;
let previousRegistry: PageRoutesRegistry | undefined;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
  previousRegistry = connectPageRoutes({
    routes,
    createHttp: (match: PageRouteMatch) =>
      createCoreHttp({ url: match.entry.path, params: match.params, query: match.query }),
  });

  // The whole dev-server handler: url in, document out, headers copied over.
  // Note: content-type is set HERE — the pipeline's headers carry cache/cookie
  // semantics but never a content type (a finding for slice 4b's real server).
  server = createServer(async (req, res) => {
    const rendered = await renderPageRequest(req.url ?? "/");

    res.writeHead(rendered.status, {
      "content-type": "text/html; charset=utf-8",
      ...rendered.headers,
    });
    res.end(rendered.html);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
  connectPageRoutes(previousRegistry);
});

beforeEach(() => {
  // This machine exports NODE_ENV=production globally (A.3 §5 finding).
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev-server smoke — a real GET yields the real document", () => {
  it("serves /products/42?user=hasan as a full HTML document over the wire", async () => {
    const response = await fetch(`${baseUrl}/products/42?user=hasan`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(body).toContain(`<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">`);
    expect(body).toContain("<h1>Product 42</h1>");
    expect(body).toContain("<title>Product 42</title>");
  });

  it("holds the payload contract on the RAW response bytes: no unescaped </script, no request/response", async () => {
    const response = await fetch(`${baseUrl}/products/42?user=hasan`);
    const body = await response.text();

    // The one legitimate </script> per script element closes it; the payload
    // block itself must contain none. Assert on the block's exact bytes.
    const open = `<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">`;
    const start = body.indexOf(open);

    expect(start).toBeGreaterThan(-1);

    const payload = body.slice(start + open.length, body.indexOf("</script>", start));

    expect(payload).not.toContain("</script");
    expect(payload).not.toContain('"request"');
    expect(payload).not.toContain('"response"');
    expect(body).not.toContain('"request"');
    expect(body).not.toContain('"response"');
  });

  it("serves the two-line page as a full document with no page-data payload", async () => {
    const response = await fetch(`${baseUrl}/contact-us`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(body).toContain("<h1>Contact us</h1>");
    expect(body).not.toContain('"pageData"');
  });

  it("answers a url matching nothing with 404 over the socket", async () => {
    const response = await fetch(`${baseUrl}/no-such-page`);

    expect(response.status).toBe(404);
  });

  it("keeps concurrent requests isolated through one real listener", async () => {
    const [amber, noor] = await Promise.all([
      fetch(`${baseUrl}/products/42?user=amber`).then((r) => r.text()),
      fetch(`${baseUrl}/products/77?user=noor`).then((r) => r.text()),
    ]);

    expect(amber).toContain("<h1>Product 42</h1>");
    expect(amber).toContain('"user":{"name":"amber"}');
    expect(amber).not.toContain("noor");
    expect(noor).toContain("<h1>Product 77</h1>");
    expect(noor).toContain('"user":{"name":"noor"}');
    expect(noor).not.toContain("amber");
  });
});
