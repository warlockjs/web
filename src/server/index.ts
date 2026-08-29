/**
 * The pipeline-facing seam. Deliberately NOT re-exported from the app-facing
 * barrel (web/src/index.ts) — the same rule A.3 set for
 * connectSharedStore/enterSharedScope/sealShared: app code never touches the
 * pipeline's wiring surface.
 */
export { connectSharedStore } from "../shared";
export {
  connectPageRoutes,
  escapePayload,
  PAYLOAD_SCRIPT_ID,
  renderPage,
  renderPageRequest,
  type PageRoutesRegistry,
  type RenderedPage,
  type RenderPageOptions,
  type RenderPageRequestOptions,
} from "./render-page";
export {
  connectPageContext,
  executePageRequest,
  type BufferedCookie,
  type BufferedHeader,
  type ExecutePageRequestOptions,
  type LoaderShortCircuitKind,
  type PageBoundaryDesignation,
  type PageContextRunner,
  type PageDataBundle,
  type PageLevelName,
  type PageResponseCommit,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageShortCircuit,
  type PageTripleModule,
  type PipelineLoader,
  type PipelineMiddleware,
  type PipelineStore,
} from "./execute-page-request";
export {
  createPageModuleLoader,
  PageModuleNotInManifestError,
} from "./create-page-module-loader";
export {
  installPageRoutesFromManifest,
  type InstalledManifestPageRoute,
  type InstallPageRoutesFromManifestOptions,
  type PageRouteHandlerFactory,
} from "./install-page-routes-from-manifest";
export {
  composeRoutePath,
  installPageRoutes,
  type InstalledPageRoute,
  type InstallPageRoutesOptions,
  type LayoutModuleShape,
  type PageModuleShape,
  type PageRouteExport,
} from "./install-page-routes";
export {
  acceptsHtmlExplicitly,
  classifyUnmatchedRequest,
  createNotFoundRouteHandler,
  DuplicateNotFoundPageError,
  frameworkDefaultNotFoundDocument,
  isNotFoundPageFile,
  NotFoundPageDeclaresRouteError,
  NOT_FOUND_PAGE_FILENAME,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
  type NotFoundRouteHandlerOptions,
  type RegisteredRouteShape,
  type UnmatchedRequestKind,
} from "./not-found-page";
export {
  devStylesheetUrls,
  productionStylesheetUrls,
  VITE_DIRECT_CSS_QUERY,
} from "./stylesheet-urls";
