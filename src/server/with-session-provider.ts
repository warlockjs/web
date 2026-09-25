import { createElement, type ReactNode } from "react";
import { SessionContext } from "../session/use-user";
import type { SessionUser } from "../session/session.types";

/**
 * Server-render seam for `useUser()`. The client store is module-level and
 * must never be written on the server (it would leak one request's user into
 * the next), so SSR supplies the resolved user through `SessionContext`
 * instead. Without a `session` payload key (no `web.session` configured) the
 * tree is left untouched and `useUser()` reads the empty store: a guest.
 */
export function withSessionProvider(
  session: { readonly user?: unknown } | undefined,
  element: ReactNode,
): ReactNode {
  if (session === undefined) return element;

  const user = (session.user ?? null) as SessionUser | null;

  return createElement(SessionContext.Provider, { value: { user }, children: element });
}
