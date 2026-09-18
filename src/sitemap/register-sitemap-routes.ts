/**
 * `GET <sitemap path>` and `GET /<shard file>` (contract Part 4 rule 6, Part
 * B checklist item 1). Both handlers only ever READ
 * {@link getSitemapArtifacts} — neither calls {@link regenerateSitemap} or
 * {@link generateSitemap}. A request that arrives before the first
 * successful generation gets a `503` with `Retry-After`, never a silent
 * `404` and never a generation kicked off on its behalf.
 */
import { readFile } from "node:fs/promises";
import type { HttpContext, Response, ReturnedResponse, Router } from "@warlock.js/core";
import { getSitemapArtifacts, type SitemapArtifactFile } from "./sitemap-lifecycle";

/** Seconds. Arbitrary but short: the first generation is expected to finish well inside this. */
const NOT_GENERATED_RETRY_AFTER_SECONDS = 30;

async function serveArtifactFile(
  response: Response,
  file: SitemapArtifactFile,
): Promise<ReturnedResponse> {
  if (file.gzipped) {
    const buffer = await readFile(file.absolutePath);

    response.header("Content-Encoding", "gzip");

    return response.sendBuffer(buffer, { contentType: "application/xml" }) as ReturnedResponse;
  }

  const xml = await readFile(file.absolutePath, "utf8");

  return response.xml(xml) as ReturnedResponse;
}

function serveNotGeneratedYet(
  response: Response,
  warn: (message: string) => void,
): ReturnedResponse {
  warn(
    "[warlock:web] a sitemap request arrived before the first successful generation completed " +
      "— serving 503 rather than a silent 404. If this persists, check the build/boot logs for a " +
      "sitemap generation failure.",
  );

  return response
    .header("Retry-After", String(NOT_GENERATED_RETRY_AFTER_SECONDS))
    .serviceUnavailable({ error: "sitemap has not been generated yet" }) as ReturnedResponse;
}

export type RegisterSitemapRoutesOptions = {
  /** The configured `web.sitemap.path` — `resolveSitemapConfig().path`. */
  path: string;
  warn?: (message: string) => void;
};

/**
 * Shard/index file STEMS `@warlock.js/sitemap` produces — always
 * `sitemap<...>` (`filePrefix` defaults to `"sitemap"` and
 * `generate-sitemap.ts` never overrides it). The extension is deliberately
 * OUTSIDE the regex group, as a literal path suffix — find-my-way's own
 * documented idiom (`/example/:file(^\\d+).png`) — rather than folded into
 * the pattern, so the router never has to parse a dot inside a parametric
 * regex group.
 *
 * Constrained at all so this route only ever intercepts paths SHAPED like a
 * sitemap artifact: every other unmatched top-level request (a real 404, a
 * typo'd page) falls through untouched, exactly as if this route did not
 * exist.
 */
const SHARD_STEM_PATTERN = "^sitemap[A-Za-z0-9_-]*";

function shardRequestHandler(extension: string, warn: (message: string) => void) {
  return ({ request, response }: HttpContext) => {
    const artifacts = getSitemapArtifacts();

    if (!artifacts) return serveNotGeneratedYet(response, warn);

    const stem = (request.params as Record<string, string>).sitemapArtifactFile;
    const file = artifacts.shardFiles.get(`/${stem}${extension}`);

    if (!file) return response.notFound() as ReturnedResponse;

    return serveArtifactFile(response, file);
  };
}

export function registerSitemapRoutes(router: Router, options: RegisterSitemapRoutesOptions): void {
  const warn = options.warn ?? console.warn;

  router.get(options.path, ({ response }) => {
    const artifacts = getSitemapArtifacts();

    if (!artifacts) return serveNotGeneratedYet(response, warn);

    return serveArtifactFile(response, artifacts.mainFile);
  });

  // Shards are always served at the site root (`/${fileName}`), regardless of
  // `options.path`'s own directory — that is where `@warlock.js/sitemap`
  // writes `<loc>` entries in the index (`joinOrigin(baseUrl, file.fileName)`,
  // no directory segment), so the served URL has to match unconditionally.
  //
  // A pair of param routes rather than one literal route per shard: shard
  // filenames are only known AFTER the first generation, and production's
  // route table is fixed at `HttpConnector.start()`'s scan
  // (`core/src/router/router.ts` `scan()`), before any generation has run.
  // Membership is checked per request against the last-good set instead —
  // this never generates, and a request for an unrecognised name gets the
  // same `404` it would if no route existed here at all.
  router.get(`/:sitemapArtifactFile(${SHARD_STEM_PATTERN}).xml`, shardRequestHandler(".xml", warn));
  router.get(
    `/:sitemapArtifactFile(${SHARD_STEM_PATTERN}).xml.gz`,
    shardRequestHandler(".xml.gz", warn),
  );
}
