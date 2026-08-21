/**
 * The pipeline-facing seam. Deliberately NOT re-exported from the app-facing
 * barrel (web/src/index.ts) — the same rule A.3 set for
 * connectSharedStore/enterSharedScope/sealShared: app code never touches the
 * pipeline's wiring surface.
 */
export {
  createBufferedResponse,
  isLoaderShortCircuit,
  LOADER_SHORT_CIRCUIT,
  type BufferedCookie,
  type BufferedHeader,
  type BufferedWebResponse,
  type LoaderShortCircuitSignal,
  type ResponseBuffer,
} from "./buffered-response";
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
  type ExecutePageRequestOptions,
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
