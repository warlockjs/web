/**
 * POST a form to a page's action and classify what the server answered.
 *
 * The browser half of the JS path in the page-actions design (§2.5). Like
 * `fetch-page-data.ts` it never throws and never reports a failure to the user:
 * it reports a result and the caller decides. Unlike it, a failure here is NOT
 * a reason to leave the page — the user is already where they want to be and
 * has just typed into a form, so `hard-fail` keeps the screen and announces.
 */
import { parse } from "devalue";
import {
  DATA_RESPONSE_CONTENT_TYPE,
  WARLOCK_DATA_REQUEST_HEADER,
  WARLOCK_DATA_REQUEST_VALUE,
} from "../../routing/data-request";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { readPageDataResponse } from "./fetch-page-data";

const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** The header a 204 carries to tell the client where the action sent it. */
export const ACTION_REDIRECT_HEADER = "x-warlock-redirect";

export type SubmitPageActionResult =
  | {
      /** 200: loaders re-ran, the page swaps in place. */
      type: "payload";
      payload: HydrationDocumentPayloadSource;
      url: string;
    }
  | {
      /** 4xx with `{ actionData }` only: apply the errors, keep the tree. */
      type: "actionOnly";
      actionData: Readonly<Record<string, unknown>>;
      status: number;
    }
  | {
      /** 204 + `x-warlock-redirect`. */
      type: "redirect";
      url: string;
    }
  | {
      /** Anything else, including network failure. */
      type: "hard-fail";
      reason: string;
    }
  | {
      /** The caller's own signal aborted it. Not a failure. */
      type: "aborted";
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function submitPageAction(
  url: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<SubmitPageActionResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
        accept: `${NDJSON_CONTENT_TYPE}, ${DATA_RESPONSE_CONTENT_TYPE}`,
      },
      // No content-type: the browser sets the multipart boundary itself.
      body: formData,
      credentials: "same-origin",
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { type: "aborted" };

    return { type: "hard-fail", reason: `request failed: ${String(error)}` };
  }

  if (response.status === 204) {
    const location = response.headers.get(ACTION_REDIRECT_HEADER);

    if (location) return { type: "redirect", url: location };

    return { type: "hard-fail", reason: "204 without a redirect header" };
  }

  if (response.status === 200) {
    const result = await readPageDataResponse(response, url);

    if (result.type === "payload") return result;
    if (result.type === "aborted") return { type: "aborted" };

    return { type: "hard-fail", reason: result.reason };
  }

  if (response.status === 422) {
    try {
      const body: unknown = parse(await response.text());

      if (isPlainRecord(body) && isPlainRecord(body.actionData)) {
        return { type: "actionOnly", actionData: body.actionData, status: response.status };
      }
    } catch {
      // Falls through to the hard failure below.
    }

    return { type: "hard-fail", reason: "status 422 without an actionData body" };
  }

  return { type: "hard-fail", reason: `status ${response.status}` };
}
