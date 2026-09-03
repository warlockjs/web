/**
 * Ask the server for a URL's page data instead of its document.
 *
 * This is the browser half of the representation split: the same route the user
 * would have loaded, asked for as JSON via the `x-warlock-data` marker. What
 * comes back is exactly the payload a full page load embeds, so the caller can
 * rebuild the tree from it with no second code path.
 *
 * ## Every failure degrades to a REAL navigation, never to an error screen
 *
 * A client navigation is an OPTIMISATION over what the browser already does
 * perfectly well. So nothing here reports a failure to the user — it reports
 * `hard-navigate`, and the caller hands the URL back to the browser. The user
 * gets the page; they just get it the slow way.
 *
 * That is what makes the whole feature safe to add: the worst case of a bug in
 * this file is the behaviour we had before the file existed. Rendering our own
 * "navigation failed" state would be strictly worse than the fallback we
 * already have, and would turn every unhandled edge — an auth redirect to an
 * external IdP, a maintenance page, a proxy that strips the header, a deploy
 * that changed the payload shape mid-session — into a dead end.
 */
import {
  DATA_RESPONSE_CONTENT_TYPE,
  WARLOCK_DATA_REQUEST_HEADER,
  WARLOCK_DATA_REQUEST_VALUE,
} from "../../routing/data-request";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";

export type PageDataResult =
  | {
      type: "payload";
      /**
       * The payload to rebuild the tree from.
       */
      payload: HydrationDocumentPayloadSource;
      /**
       * The URL the response actually came from — NOT the one requested. A
       * redirect is followed by `fetch` transparently, so a login-required page
       * answers from `/login`, and pushing the requested URL into history would
       * leave the address bar lying about what is on screen.
       */
      url: string;
    }
  | {
      type: "hard-navigate";
      url: string;
      /** Why, for a console warning — never shown to the user. */
      reason: string;
    };

/**
 * Whether the body is the payload we asked for.
 *
 * Checked rather than assumed because a 200 does not mean "this came from the
 * page pipeline": a captive portal, an SSO interstitial or a proxy error page
 * all answer 200 with HTML. Parsing that as JSON would throw; treating a
 * successful parse of *something else* as a payload would render garbage.
 */
function isPayloadResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(DATA_RESPONSE_CONTENT_TYPE);
}

/**
 * The shape check, kept deliberately narrow: `name` is the only field the tree
 * builder cannot proceed without — it selects the page. The data fields are
 * page-defined and may legitimately be anything, including `null`.
 */
function isPayloadShape(value: unknown): value is HydrationDocumentPayloadSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { locale?: unknown }).locale === "string" &&
    (value as { locale: string }).locale.length > 0
  );
}

export async function fetchPageData(url: string): Promise<PageDataResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
        accept: DATA_RESPONSE_CONTENT_TYPE,
      },
      // Same-origin credentials so a navigation carries the session exactly as
      // a document request would. Without this a client navigation could be
      // logged out while a full load of the same URL is not.
      credentials: "same-origin",
      // Redirects are FOLLOWED, not intercepted: the marker header is re-sent,
      // so the destination answers with a payload too, and `response.url` tells
      // us where we ended up. Handling redirects ourselves would mean
      // re-implementing the rules the browser already has.
      redirect: "follow",
    });
  } catch (error) {
    // Offline, DNS, CORS, an aborted connection. The browser can render its own
    // network error far better than we can fake one.
    return { type: "hard-navigate", url, reason: `request failed: ${String(error)}` };
  }

  if (!response.ok) {
    // 404, 500, 403 — all of these have a real page the server renders. Letting
    // the browser load it gets the correct status AND the correct document,
    // rather than us inventing a client-side error state that the server's own
    // error page already covers.
    return { type: "hard-navigate", url, reason: `status ${response.status}` };
  }

  if (!isPayloadResponse(response)) {
    return {
      type: "hard-navigate",
      url,
      reason: `unexpected content-type "${response.headers.get("content-type") ?? "none"}"`,
    };
  }

  let parsed: unknown;

  try {
    parsed = await response.json();
  } catch (error) {
    return { type: "hard-navigate", url, reason: `malformed JSON: ${String(error)}` };
  }

  if (!isPayloadShape(parsed)) {
    return { type: "hard-navigate", url, reason: "payload has no route name" };
  }

  // `response.url` is absolute and reflects any redirect that was followed.
  // Falling back to the requested URL keeps this working under test doubles
  // that do not set it.
  return { type: "payload", payload: parsed, url: response.url || url };
}
