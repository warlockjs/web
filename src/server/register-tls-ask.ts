import type { Router } from "@warlock.js/core";
import type { WebConfigurations } from "../configurations";
import { createTlsAskHandler } from "./tls-ask";

/** Registers Caddy's optional ask endpoint as an ordinary, non-page route. */
export function registerTlsAsk(router: Router, web: WebConfigurations): void {
  if (web.tlsAsk === undefined) return;

  if (web.sites === undefined) {
    throw new Error("web.tlsAsk requires web.sites so domains can be selected.");
  }

  const ask = createTlsAskHandler({
    sites: web.sites,
    resolveHost: web.resolveHost,
    resolveCache: web.resolveCache,
  });

  router.get(web.tlsAsk, async ({ request, response }) => {
    const result = await ask({ domain: request.query.domain as string | undefined, request });
    await response.send("", result.status);
  });
}
