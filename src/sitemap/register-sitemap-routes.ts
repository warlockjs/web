/**
 * HTTP readers for immutable sitemap manifests. Requests only read published
 * state: they never regenerate, upload, poll manually, or touch lifecycle
 * ownership. Storage streams go directly to Fastify after Response has set
 * the protocol headers; Response.stream() is unsuitable here because it
 * unconditionally installs `Cache-Control: no-cache` before writing headers.
 */
import path from "node:path";
import type { HttpContext, Response, ReturnedResponse, Router } from "@warlock.js/core";
import type { SitemapGenerationFile, SitemapGenerationManifest } from "@warlock.js/sitemap";
import { getSitemapServingState } from "./sitemap-lifecycle";
import { resolveSitemapHttpValidators } from "./sitemap-http-validators";
import type { SitemapServingState } from "./sitemap-serving-state";
import {
  buildSiteSitemapXml,
  createSitemapSiteSelector,
  isNonIndexableDynamicSite,
  selectSitemapSite,
} from "./site-sitemap";
import type { SitemapPageSource } from "./sitemap-page-source";

const NOT_GENERATED_RETRY_AFTER_SECONDS = 30;
const IMMUTABLE_GENERATION_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SAFE_GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

// `generateSitemapArtifacts()` delegates sharded output to SitemapIndex without
// overriding its defaults: `sitemap.xml`, `sitemap_index.xml`, `sitemap-0001.xml`,
// `sitemap-<source>-0001.xml`, and optional shard `.gz` forms. The configured main path is registered as an
// exact route below, so this compatibility route must not become a one-segment
// catch-all that prevents Web's normal not-found handling.
const LEGACY_BARE_SHARD_ROUTE =
  "/:sitemapArtifactFile(^sitemap(?:\\.xml|_index\\.xml|-(?:[0-9]{4,}|[A-Za-z0-9_-]+-[0-9]{4,})\\.xml(?:\\.gz)?)$)";
const LEGACY_BARE_SHARD_FILE_NAME =
  /^sitemap(?:\.xml|_index\.xml|-(?:[0-9]{4,}|[A-Za-z0-9_-]+-[0-9]{4,})\.xml(?:\.gz)?)$/;

type SitemapRouteContext = Pick<HttpContext, "request" | "response">;
type SitemapRouteHandler = (context: SitemapRouteContext) => Promise<ReturnedResponse>;

/**
 * Core's router does not infer a HEAD route from GET. Every sitemap artifact
 * is conditionally readable, so register the same manifest handler for both
 * methods instead of leaving HEAD to a framework-specific fallback.
 */
function registerReadableRoute(
  router: Router,
  routePath: string,
  handler: SitemapRouteHandler,
): void {
  router.get(routePath, handler);
  router.head(routePath, handler);
}

function serveNotGeneratedYet(
  response: Response,
  warn: (message: string) => void,
): ReturnedResponse {
  warn(
    "[warlock:web] a sitemap request arrived before the first successful generation completed " +
      "� serving 503 rather than a silent 404. If this persists, check the build/boot logs for a " +
      "sitemap generation failure.",
  );

  return response
    .header("Retry-After", String(NOT_GENERATED_RETRY_AFTER_SECONDS))
    .serviceUnavailable({ error: "sitemap has not been generated yet" }) as ReturnedResponse;
}

function isGzipped(file: SitemapGenerationFile): boolean {
  return file.path.endsWith(".gz");
}

function safeFileName(value: string | undefined): value is string {
  return (
    value !== undefined &&
    SAFE_FILE_NAME.test(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function fileFromManifest(
  manifest: SitemapGenerationManifest,
  filePath: string,
): SitemapGenerationFile | undefined {
  return manifest.files.find((file) => file.path === filePath);
}

async function serveManifestFile(
  context: SitemapRouteContext,
  state: SitemapServingState,
  manifest: SitemapGenerationManifest,
  file: SitemapGenerationFile,
  cacheControl: string,
): Promise<ReturnedResponse> {
  const { request, response } = context;
  const ifNoneMatch = request.header("if-none-match");
  const ifModifiedSince = request.header("if-modified-since");
  const validators = resolveSitemapHttpValidators({
    sha256: file.sha256,
    generatedAt: manifest.generatedAt,
    // Core's Request.header() uses null for an absent header. Validators use
    // undefined to distinguish an absent conditional from a supplied value.
    ifNoneMatch: typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
    ifModifiedSince: typeof ifModifiedSince === "string" ? ifModifiedSince : undefined,
    method: request.method,
    cacheControl,
  });

  response
    .header("ETag", validators.etag)
    .header("Last-Modified", validators.lastModified)
    .header("Cache-Control", validators.cacheControl)
    .header("Content-Type", "application/xml");

  if (isGzipped(file)) response.header("Content-Encoding", "gzip");

  if (validators.notModified) {
    return (await response.setStatusCode(304).send()) as unknown as ReturnedResponse;
  }

  if (request.method === "HEAD") {
    return (await response.send()) as unknown as ReturnedResponse;
  }

  const artifact = await state.store.getArtifactStream(manifest, file.path);

  // `Response.send(stream)` parses iterable streams and buffers them. The
  // underlying Fastify reply is the narrow existing escape hatch that preserves
  // the storage stream and headers without materialising XML in memory.
  return response.baseResponse.send(artifact) as unknown as ReturnedResponse;
}

async function resolveGenerationManifest(
  state: SitemapServingState,
  generationId: string,
): Promise<SitemapGenerationManifest | undefined> {
  const current = await state.getManifest();

  if (current?.generationId === generationId) return current;

  return state.store.readManifestByGeneration(generationId);
}

function generationRequestHandler(
  getServingState: () => SitemapServingState | undefined,
  warn: (message: string) => void,
) {
  return async (context: SitemapRouteContext): Promise<ReturnedResponse> => {
    const { request, response } = context;
    const state = getServingState();

    if (!state) return serveNotGeneratedYet(response, warn);

    const params = request.params as Record<string, string | undefined>;
    const generationId = params.sitemapGenerationId;
    const fileName = params.sitemapGenerationFile;

    if (!generationId || !SAFE_GENERATION_ID.test(generationId) || !safeFileName(fileName)) {
      return response.notFound() as ReturnedResponse;
    }

    const manifest = await resolveGenerationManifest(state, generationId);

    if (!manifest) return response.notFound() as ReturnedResponse;

    const file = fileFromManifest(manifest, `generations/${generationId}/${fileName}`);

    if (!file) return response.notFound() as ReturnedResponse;

    return serveManifestFile(context, state, manifest, file, IMMUTABLE_GENERATION_CACHE_CONTROL);
  };
}

function latestBareShardHandler(
  getServingState: () => SitemapServingState | undefined,
  warn: (message: string) => void,
) {
  return async (context: SitemapRouteContext): Promise<ReturnedResponse> => {
    const { request, response } = context;
    const fileName = (request.params as Record<string, string | undefined>).sitemapArtifactFile;

    // The route expression is deliberately simple enough for find-my-way's
    // safe-regex check. Validate the complete generator-owned shape before
    // reading serving state, so a near-miss can never turn into sitemap's 503.
    if (!safeFileName(fileName) || !LEGACY_BARE_SHARD_FILE_NAME.test(fileName)) {
      return response.notFound() as ReturnedResponse;
    }

    const state = getServingState();

    if (!state) return serveNotGeneratedYet(response, warn);

    const manifest = await state.getManifest();

    if (!manifest) return serveNotGeneratedYet(response, warn);

    const file = manifest.files.find((candidate) => path.basename(candidate.path) === fileName);

    if (!file) return response.notFound() as ReturnedResponse;

    return serveManifestFile(context, state, manifest, file, IMMUTABLE_GENERATION_CACHE_CONTROL);
  };
}

export type RegisterSitemapRoutesOptions = {
  /** The configured `web.sitemap.path` � `resolveSitemapConfig().path`. */
  readonly path: string;
  readonly warn?: (message: string) => void;
  /** Test seam; production reads the lifecycle's serving-state getter. */
  readonly getServingState?: () => SitemapServingState | undefined;
  /** App root and source are forwarded only by the multi-site in-memory reader. */
  readonly appRoot?: string;
  readonly pageSource?: SitemapPageSource;
};

/**
 * Registers the stable index/single route and immutable generation-file route.
 * A route read never invokes regeneration: before the first manifest it is a
 * 503, while absent/expired immutable generations are ordinary 404s.
 */
export function registerSitemapRoutes(router: Router, options: RegisterSitemapRoutesOptions): void {
  const warn = options.warn ?? console.warn;
  const getServingState = options.getServingState ?? getSitemapServingState;
  const siteSelector = createSitemapSiteSelector();

  const currentManifestHandler: SitemapRouteHandler = async (context) => {
    const selected = await selectSitemapSite(context.request, siteSelector);
    if (selected?.kind === "not-found" || (selected && isNonIndexableDynamicSite(selected))) {
      return context.response.notFound() as ReturnedResponse;
    }
    if (selected) {
      context.response.header("Content-Type", "application/xml");
      return context.response.text(
        await buildSiteSitemapXml({
          request: context.request,
          site: selected,
          appRoot: options.appRoot,
          pageSource: options.pageSource,
        }),
      ) as ReturnedResponse;
    }

    const state = getServingState();

    if (!state) return serveNotGeneratedYet(context.response, warn);

    const manifest = await state.getManifest();

    if (!manifest) return serveNotGeneratedYet(context.response, warn);

    const file = fileFromManifest(manifest, manifest.mainFile);

    if (!file) return context.response.notFound() as ReturnedResponse;

    return serveManifestFile(context, state, manifest, file, state.cacheControl);
  };

  registerReadableRoute(router, options.path, currentManifestHandler);
  registerReadableRoute(
    router,
    "/sitemaps/:sitemapGenerationId/:sitemapGenerationFile",
    generationRequestHandler(getServingState, warn),
  );

  // Backwards compatibility for generated bare artifact URLs. The route grammar itself
  // is deliberately constrained before lifecycle state is read, so unrelated
  // one-segment URLs continue to Web's ordinary not-found route.
  registerReadableRoute(
    router,
    LEGACY_BARE_SHARD_ROUTE,
    latestBareShardHandler(getServingState, warn),
  );
}
