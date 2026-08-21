import type { LayoutLoader, LayoutProps } from "../../../src/index";
import { shared } from "../../../src/index";
import "./types";

/**
 * The fixture layout (v5/app products/web/layout.tsx shape): a guard
 * middleware that may short-circuit, and a loader that both returns data and
 * writes a buffered response header — the root-side writer for the
 * root→leaf commit-order proof.
 */

/**
 * Middleware short-circuit uses core's exact rule — any `output !== undefined`
 * stops the chain (core/src/http/request.ts:769). Returning the response
 * with a status set is the fixture's stand-in for a real 401 guard.
 */
const guard = async ({ request, response }: { request: any; response: any }) => {
  if (request.input("deny")) {
    return response.setStatusCode(401);
  }
};

export const middleware = [guard];

export const loader = (async () => {
  return { nav: ["home", "products"], locale: shared.locale };
}) satisfies LayoutLoader;

export default function Layout({ data, children }: LayoutProps<typeof loader>) {
  return (
    <div id="layout">
      <nav>{data?.nav?.join(" | ")}</nav>
      {children}
    </div>
  );
}
