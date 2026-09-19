import { Component, createElement, type ComponentType, type ReactNode } from "react";
import type { SerializedErrorPageProps } from "../hydration-payload";
import { renderBuiltInFallback } from "./built-in-error-fallback";
import { statusOf } from "./client-error-status";
import { ErrorPageRenderGuard } from "./error-page-render-guard";
import { reportClientError } from "./report-client-error";
import { sanitizeClientError } from "./sanitize-client-error";

type DefaultErrorBoundaryProps = {
  children: ReactNode;
  /**
   * Changes on every applied payload swap — a navigation, a refresh, a
   * locale change (`navigation-root.tsx`'s `applySwap`). NOT the route name:
   * a same-name swap (`/posts/1` -> `/posts/2`, or `refresh()` on the page
   * already on screen) must also clear a stale error, and a changing `key`
   * would remount the whole subtree — including layouts — to do that, which
   * is the regression this prop exists to avoid. See `componentDidUpdate`.
   */
  resetToken: number;
  /**
   * The CURRENT route's app-owned `error.page.tsx`, resolved the same way
   * `build-hydrated-tree.ts` resolves it for a server-selected error render
   * (`navigation-root.tsx`'s own resolution, from the same page registry) —
   * `undefined` when the route has none, or while it is still loading.
   * Rendered with a freshly sanitized `SerializedErrorPageProps` rather than
   * any props the payload may separately carry: that payload describes a
   * DIFFERENT, server-selected failure made before the shell flushed, and
   * this floor exists for failures that happen strictly after hydration.
   */
  errorPage?: ComponentType<SerializedErrorPageProps>;
};

type DefaultErrorBoundaryState = {
  error: unknown;
};

/**
 * The framework-owned client floor. `NavigationRoot` wraps the composed
 * Layout(Page) tree in this — both on the hydration render and on every
 * later swap — so an error nothing else caught, most commonly `use()`
 * throwing on a rejected `defer()` value (`defer-registry.ts`), renders the
 * app's own error page when one is configured for the current route, and the
 * floor's fixed fallback otherwise — instead of React unmounting the tree
 * with no trace.
 *
 * An app-authored ErrorBoundary anywhere inside `children` is always the
 * NEARER boundary and catches first; React walks up to the closest one, so
 * this floor only ever fires when the app provided none.
 */
export class DefaultErrorBoundary extends Component<
  DefaultErrorBoundaryProps,
  DefaultErrorBoundaryState
> {
  public state: DefaultErrorBoundaryState = { error: undefined };

  public static getDerivedStateFromError(error: unknown): DefaultErrorBoundaryState {
    return { error };
  }

  /**
   * One report per swap. When the fallback this floor renders (the app's
   * error page) throws too, React retries the render, which re-runs the
   * failing tree and delivers `componentDidCatch` again with a NEW error
   * object for the same failure. Once caught, the children are not rendered
   * again until the next swap, so nothing distinct is lost; the flag is
   * cleared on every swap, so a later failure is always reported.
   */
  private reportedSinceSwap = false;

  public componentDidCatch(error: unknown): void {
    // Reported UNCONDITIONALLY, the same guarantee `defer-settlement.ts`'s
    // `reportServerError` gives a rejection's server half — never gated on
    // whether the app wired up its own error reporting, and never repeated
    // if the error page chosen below goes on to throw its own error — see
    // `ErrorPageRenderGuard`.
    if (this.reportedSinceSwap) return;

    this.reportedSinceSwap = true;
    reportClientError("an uncaught error reached the default client boundary", error, {
      kind: "boundary",
      pathname: typeof window === "undefined" ? undefined : window.location.pathname,
    });
  }

  public componentDidUpdate(previousProps: DefaultErrorBoundaryProps): void {
    // Every applied swap moves `resetToken`, whether or not it changed the
    // page's name — a fresh, presumably healthy tree deserves a fresh
    // chance to render rather than inheriting a fallback caught for the
    // tree that just left. Gated on the error state so a swap that is not
    // recovering from anything does not force an extra render.
    if (previousProps.resetToken !== this.props.resetToken) {
      this.reportedSinceSwap = false;

      if (this.state.error !== undefined) this.setState({ error: undefined });
    }
  }

  public render(): ReactNode {
    if (this.state.error !== undefined) {
      const { errorPage } = this.props;

      if (errorPage === undefined) {
        return renderBuiltInFallback();
      }

      const error = this.state.error;

      return createElement(ErrorPageRenderGuard, {
        ErrorPage: errorPage,
        errorPageProps: { error: sanitizeClientError(error), status: statusOf(error) },
      });
    }

    return this.props.children;
  }
}
