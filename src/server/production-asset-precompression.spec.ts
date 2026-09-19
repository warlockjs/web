/**
 * Red-first specs for precompressed hashed-asset negotiation (card `011315ae`).
 *
 * Proven against a real Fastify response, the same way
 * `static-asset-cache-headers.spec.ts` proves Cache-Control: `router.scan(server)`
 * plus `server.inject()` exercises the exact `@fastify/static` code path
 * production uses, with `preCompressed: true` set by
 * `productionAssetsDirectoryOptions`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { router } from "@warlock.js/core";
import { productionAssetsDirectoryOptions } from "./web-connector";

const temporaryDirectories: string[] = [];

function writeHashedAssetWithSiblings(): { dir: string; contents: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-precompression-"));
  temporaryDirectories.push(dir);

  const assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const contents = "console.log('hydration entry');".repeat(200);
  fs.writeFileSync(path.join(assetsDir, "hydration-a1b2c3d4.js"), contents, "utf-8");
  fs.writeFileSync(
    path.join(assetsDir, "hydration-a1b2c3d4.js.br"),
    zlib.brotliCompressSync(contents),
  );
  fs.writeFileSync(
    path.join(assetsDir, "hydration-a1b2c3d4.js.gz"),
    zlib.gzipSync(contents, { level: 9 }),
  );

  return { dir, contents };
}

afterAll(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("production precompressed asset negotiation", () => {
  const server = Fastify();

  const { dir: clientDir, contents } = writeHashedAssetWithSiblings();

  router.directory(productionAssetsDirectoryOptions(clientDir));

  beforeAll(() => {
    router.scan(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves brotli when the client accepts br", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "gzip, br" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-type"]).toContain("javascript");
    expect(zlib.brotliDecompressSync(response.rawPayload).toString("utf-8")).toBe(contents);
  });

  it("prefers br over gzip when q-values tie in the client's favor", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "gzip;q=1.0, br;q=1.0" },
    });

    expect(response.headers["content-encoding"]).toBe("br");
  });

  it("serves gzip when only gzip is accepted", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-type"]).toContain("javascript");
    expect(zlib.gunzipSync(response.rawPayload).toString("utf-8")).toBe(contents);
  });

  it("serves identity when no encoding is accepted", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "identity" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawPayload.toString("utf-8")).toBe(contents);
  });

  it("always sets Vary: Accept-Encoding, even on identity responses", async () => {
    const brResponse = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "br" },
    });
    const identityResponse = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "identity" },
    });

    expect(brResponse.headers.vary).toBe("Accept-Encoding");
    expect(identityResponse.headers.vary).toBe("Accept-Encoding");
  });

  it("still sets the one-year immutable Cache-Control on a compressed response", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/hydration-a1b2c3d4.js",
      headers: { "accept-encoding": "br" },
    });

    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
});
