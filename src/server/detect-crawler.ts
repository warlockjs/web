/**
 * Crawler detection for the fully-resolved-document mode — the ONLY reader
 * of `web.streaming.crawlers` (`streaming-config.ts` merely declares the
 * shape and reads it off `config.get`).
 *
 * A search/social crawler that never executes the defer-bootstrap script
 * would index the shell forever with the deferred sections missing — it has
 * no chance to observe a later chunk the way a browser does. Detecting it and
 * switching to the await-and-inline path (`render-page.ts`'s `finishRender`)
 * is what lets it see the SAME content a human eventually would.
 */
import type { Request } from "@warlock.js/core";
import { resolveCrawlersConfig } from "./streaming-config";

/**
 * The built-in, case-insensitive user-agent list — replaced wholesale (never
 * merged) by a configured `userAgents` list. Kept as real `RegExp`s, not
 * strings, so a configured replacement takes the exact same shape.
 */
export const DEFAULT_CRAWLER_USER_AGENTS: readonly RegExp[] = [
  /googlebot/i,
  /bingbot/i,
  /yandex/i,
  /duckduckbot/i,
  /baiduspider/i,
  /slurp/i,
  /applebot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /discordbot/i,
  /slackbot/i,
  /telegrambot/i,
  /whatsapp/i,
  /embedly/i,
  /pinterest/i,
];

/**
 * True when `request` should receive the fully resolved document instead of
 * the streamed shell + deferred chunks.
 *
 * Precedence, per the lead's fixed decisions: `web.streaming.crawlers ===
 * false` always answers `false` (detection is off, full stop — a configured
 * `detect` never even runs); a configured `detect` wins outright over the
 * user-agent list; otherwise the (possibly configured) `userAgents` list is
 * matched against the request's `User-Agent` header.
 */
export function isCrawlerRequest(request: Request): boolean {
  const crawlers = resolveCrawlersConfig();

  if (crawlers === false) return false;

  if (crawlers?.detect) return crawlers.detect(request);

  const userAgent = String(request.header("user-agent", "") ?? "");

  if (!userAgent) return false;

  const patterns = crawlers?.userAgents ?? DEFAULT_CRAWLER_USER_AGENTS;

  return patterns.some((pattern) => pattern.test(userAgent));
}
