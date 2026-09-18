import { createElement, type ReactNode } from "react";

/** The floor's own fixed fallback — what renders when no error page applies. */
export function renderBuiltInFallback(): ReactNode {
  return createElement("main", { role: "alert" }, "Something went wrong.");
}
