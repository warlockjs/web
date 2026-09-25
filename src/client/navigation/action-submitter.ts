import { routerEvents } from "../../routing/router-events";
import { hydrateShared } from "../../shared";
import { clearPrefetchCache } from "./prefetch";
import type { RefreshRuntime } from "./refresh";
import { beginSubmitting } from "./submitting-store";
import { submitPageAction } from "./submit-page-action";

/**
 * Submit a page's action from the browser and apply the outcome (design §2.5).
 *
 * Built by `NavigationRoot` on the same four callbacks as the refresher, so a
 * submit and a navigation take tickets from ONE counter: a navigation that
 * starts while an action is pending drops the action's result, and a newer
 * submit aborts an older one.
 */
export type ActionSubmitRuntime = RefreshRuntime & {
  /** Client navigation, used for the redirect outcome (push). */
  navigate: (url: string) => void;
};

export type ActionSubmitOutcome =
  | { type: "success" }
  | { type: "error"; actionData: Readonly<Record<string, unknown>> }
  | { type: "redirected"; url: string }
  | { type: "failed"; reason: string }
  /** A newer navigation or submit overtook this one; nothing was applied. */
  | { type: "dropped" };

export type ActionSubmitter = (url: string, formData: FormData) => Promise<ActionSubmitOutcome>;

export function createActionSubmitter(runtime: ActionSubmitRuntime): ActionSubmitter {
  let inFlight: Promise<ActionSubmitOutcome> | undefined;

  async function run(url: string, formData: FormData): Promise<ActionSubmitOutcome> {
    const { isCurrent, signal, complete } = runtime.claimTicket();
    const endSubmitting = beginSubmitting();
    let completionWaitsForCommit = false;

    try {
      const result = await submitPageAction(url, formData, signal);

      if (!isCurrent() || result.type === "aborted") return { type: "dropped" };

      if (result.type === "hard-fail") {
        const error = new Error(`Warlock page action failed: ${result.reason}`);

        console.warn("Warlock page action failed:", result.reason);
        routerEvents.emitNavigationError({ url, mode: "replace", error });

        return { type: "failed", reason: result.reason };
      }

      if (result.type === "redirect") {
        clearPrefetchCache();
        runtime.navigate(result.url);

        return { type: "redirected", url: result.url };
      }

      const previous = runtime.readCurrent();

      if (result.type === "actionOnly") {
        // Errors only: keep the tree, replace what `useActionData` reads.
        runtime.writeCurrent(
          {
            payload: { ...previous.payload, actionData: result.actionData },
            tree: previous.tree,
            routeSource: previous.routeSource,
          },
          complete,
        );
        completionWaitsForCommit = true;

        return { type: "error", actionData: result.actionData };
      }

      let tree: Awaited<ReturnType<typeof runtime.buildTree>>;

      try {
        tree = await runtime.buildTree(result.payload);
      } catch (error) {
        console.warn("Warlock page action could not build the page tree:", error);
        routerEvents.emitNavigationError({ url, mode: "replace", error });

        return { type: "failed", reason: "tree build failed" };
      }

      if (!isCurrent()) return { type: "dropped" };

      hydrateShared(result.payload.shared);
      clearPrefetchCache();

      runtime.writeCurrent(
        {
          payload: result.payload,
          tree,
          routeSource:
            result.payload.name === previous.payload.name
              ? previous.routeSource
              : result.payload,
        },
        complete,
      );
      completionWaitsForCommit = true;

      return { type: "success" };
    } finally {
      endSubmitting();
      if (!completionWaitsForCommit) complete?.();
    }
  }

  return (url, formData) => {
    // A double submit shares the request in flight instead of sending a second.
    if (inFlight) return inFlight;

    const promise = run(url, formData).finally(() => {
      if (inFlight === promise) inFlight = undefined;
    });

    inFlight = promise;

    return promise;
  };
}

let connected: ActionSubmitter | undefined;

/** Installed by the navigation runtime at mount, torn down with `undefined`. */
export function connectActionSubmitter(next: ActionSubmitter | undefined): ActionSubmitter | undefined {
  const previous = connected;

  connected = next;

  return previous;
}

/** What `<Form>` calls. Resolves `undefined` when no runtime is connected. */
export async function submitAction(
  url: string,
  formData: FormData,
): Promise<ActionSubmitOutcome | undefined> {
  return connected?.(url, formData);
}
