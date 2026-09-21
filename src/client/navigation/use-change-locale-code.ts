import { useCallback, useEffect, useRef, useState } from "react";
import { changeLocaleCode } from "./change-locale-code";

/**
 * A locale switcher that knows whether it is currently switching.
 *
 * {@link changeLocaleCode} already does the work — it re-fetches the current
 * route under the new locale and lets the server persist the choice. What it
 * cannot do is tell a component that the switch is in flight, and a language
 * picker that gives no feedback while the request is out is one a user clicks
 * twice.
 *
 * So this is deliberately thin: the switching logic stays in one place, and
 * this adds only the pending state a component needs to disable a control and
 * show a spinner.
 *
 * ## Why the state is LOCAL rather than shared
 *
 * Two pickers on one page (a header menu and a footer link, say) should each
 * report their own pending state. A module-level flag would light both up when
 * one was clicked, which is a lie about what the user did. If a shared
 * indicator is ever wanted it belongs in the app, built from this.
 *
 * ## What it guarantees
 *
 * - `isLoading` is `true` from the call until the switch settles, success or
 *   failure.
 * - A failure REJECTS, and clears `isLoading` on the way out. Swallowing it
 *   would leave a picker that silently did nothing — the user clicks Arabic,
 *   the page stays English, and nothing anywhere says why.
 * - No state is set after unmount, so a component that navigates away
 *   mid-switch does not warn.
 *
 * @example
 * ```tsx
 * function LocalePicker() {
 *   const { changeLocale, isLoading } = useChangeLocaleCode();
 *
 *   return (
 *     <button disabled={isLoading} onClick={() => changeLocale("ar")}>
 *       {isLoading ? "Switching…" : "العربية"}
 *     </button>
 *   );
 * }
 * ```
 */
export type UseChangeLocaleCode = {
  /** Switch to `code`. Rejects if the switch fails. */
  changeLocaleCode: (code: string) => Promise<void>;
  /** @deprecated Use {@link changeLocaleCode}. */
  changeLocale: (code: string) => Promise<void>;
  /** Whether a switch started by THIS hook instance is in flight. */
  isLoading: boolean;
};

export function useChangeLocaleCode(): UseChangeLocaleCode {
  const [isLoading, setIsLoading] = useState(false);

  // Guards the post-await `setIsLoading(false)`. A user who switches locale and
  // immediately navigates away unmounts this component while the request is
  // still out; setting state then is a warning in the console of an app that
  // did nothing wrong.
  const mounted = useRef(true);
  const latestInvocation = useRef(0);

  // Reset on mount as well as clearing on unmount: under StrictMode the effect
  // runs, cleans up, and runs again on the same instance. Without the reset the
  // second mount would start with `mounted.current === false` and the flag
  // would never clear again — a picker disabled for good, in development only,
  // which is the kind of bug that gets blamed on React.
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      latestInvocation.current += 1;
    };
  }, []);

  const changeLocale = useCallback(async (code: string) => {
    const invocation = latestInvocation.current + 1;
    latestInvocation.current = invocation;
    setIsLoading(true);

    try {
      await changeLocaleCode(code);
    } finally {
      // `finally`, not the success path: a rejection must clear the flag too,
      // or a failed switch leaves the picker disabled forever — the control
      // the user would reach for to try again.
      if (mounted.current && latestInvocation.current === invocation) {
        setIsLoading(false);
      }
    }
  }, []);

  return { changeLocaleCode: changeLocale, changeLocale, isLoading };
}
