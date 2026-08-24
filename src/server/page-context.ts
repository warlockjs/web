import type { PageContextRunner, PipelineStore } from "./execute-page-request.types";

/**
 * Boot-time wiring for the per-request context, once per process.
 *
 * The pipeline never owns an `AsyncLocalStorage` — it borrows core's. A VALUE
 * import of core from web risks resolving a second core instance, and two
 * copies of core means two stores, so `core` stays a type-only peer and the
 * code that already has `requestContext` in scope hands it over:
 *
 * ```ts
 * connectPageContext(requestContext);
 * connectSharedStore(() => requestContext.getStore());
 * ```
 */

let pageContextRunner: PageContextRunner | undefined;
let additionalSharedScopeEntry: ((store: PipelineStore) => void) | undefined;

/** Returns the previous runner so tests can restore it. */
export function connectPageContext(
  runner: PageContextRunner | undefined,
): PageContextRunner | undefined {
  const previous = pageContextRunner;

  pageContextRunner = runner;

  return previous;
}

/**
 * Connect an additional shared-module instance that must enter every request.
 * Production has one module graph and needs none; the dev server uses this seam
 * for the Vite SSR graph that evaluates app code.
 */
export function connectPageSharedScope(
  enter: ((store: PipelineStore) => void) | undefined,
): ((store: PipelineStore) => void) | undefined {
  const previous = additionalSharedScopeEntry;

  additionalSharedScopeEntry = enter;

  return previous;
}

export function enterAdditionalSharedScope(store: PipelineStore): void {
  additionalSharedScopeEntry?.(store);
}

export function requireRunner(): PageContextRunner {
  if (!pageContextRunner) {
    throw new Error(
      "executePageRequest() has no request context connected " +
        "(web/src/server/page-context.ts). The pipeline opens the per-request " +
        "AsyncLocalStorage frame with CORE's own context — it never owns one " +
        "itself. Fix: the server bootstrap must call " +
        "connectPageContext(requestContext) (and " +
        "connectSharedStore(() => requestContext.getStore())) before any " +
        "page request runs.",
    );
  }

  return pageContextRunner;
}
