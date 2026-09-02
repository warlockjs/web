/**
 * Real response headers for the two static-asset shapes the production
 * pipeline serves, proven against an actual Fastify response rather than
 * against the function that sets it — see `web-connector.ts` (hashed
 * `assets/` directory) and `register-production-public-files.ts` (`public/`
 * files copied verbatim, not content-hashed).
 *
 * No standalone dev/production server is started here: `router.scan(server)`
 * plus `server.inject()` exercises the exact fastify-static and
 * `Response.sendFile` code paths production uses, on an in-memory Fastify
 * instance that never binds a port.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Router, router } from "@warlock.js/core";
import { registerProductionPublicFiles } from "./register-production-public-files";
import { productionAssetsDirectoryOptions } from "./web-connector";

const temporaryDirectories: string[] = [];

function writeTempFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-static-cache-"));
  temporaryDirectories.push(dir);

  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf-8");

  return dir;
}

afterAll(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("production static asset Cache-Control headers", () => {
  const server = Fastify();

  // An ordinary page route, registered on the real singleton the same way a
  // page handler is — the innocent case this suite must leave untouched.
  router.get("/__innocent-html-doc", ({ response }) => {
    return response.html("<!doctype html><html><body>ok</body></html>");
  });

  // The hashed-asset shape: content-hashed filename, served through
  // `router.directory` exactly as `web-connector.ts` configures it for
  // `<clientDir>/assets`.
  const hashedAssetsDir = writeTempFile(
    "assets/index-a1b2c3d4.js",
    "console.log('hashed');",
  );

  router.directory(productionAssetsDirectoryOptions(hashedAssetsDir));

  // The `public/` shape: NOT content-hashed, registered through the same
  // production helper `web-connector.ts` calls at boot.
  const publicClientDir = writeTempFile("public/favicon.svg", "<svg />");

  registerProductionPublicFiles(router as unknown as Router, publicClientDir, ["favicon.svg"]);

  beforeAll(() => {
    router.scan(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it("leaves an ordinary HTML document's headers unchanged", async () => {
    const response = await server.inject({ method: "GET", url: "/__innocent-html-doc" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("serves a hashed build asset as immutable for one year", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/assets/index-a1b2c3d4.js",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("serves a public/ file with a short revalidating max-age, not immutable", async () => {
    const response = await server.inject({ method: "GET", url: "/favicon.svg" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });
});
