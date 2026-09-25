import { createContext, useContext, useSyncExternalStore } from "react";
import { clearPrefetchCache } from "../client/navigation/prefetch";
import type { SessionUser } from "./session.types";

/** The wire shape of the payload's optional `session` key. */
export type SessionPayload = { readonly user?: SessionUser | null } | undefined;

let currentUser: SessionUser | null = null;

const listeners = new Set<() => void>();

/** `user?.id ?? null` — the identity prefetch entries are tagged with. */
function identityOf(user: SessionUser | null): string | number | null {
  return user === null ? null : (user as { id: string | number }).id;
}

/** The identity of the session the client currently holds. */
export function getSessionIdentity(): string | number | null {
  return identityOf(currentUser);
}

/**
 * Feed the client session store from a hydration payload's `session` key.
 * A missing key reads as a guest. Called beside every `hydrateShared`.
 *
 * An identity change clears the prefetch cache: entries fetched under the old
 * identity are pages the new one must not be served. Components re-render only
 * when the projection actually changed.
 */
export function installSession(session: SessionPayload | Readonly<Record<string, unknown>>): void {
  const raw = (session as { user?: unknown } | undefined)?.user;
  const next = (raw === undefined || raw === null ? null : raw) as SessionUser | null;

  if (next === currentUser) return;

  const identityChanged = identityOf(next) !== identityOf(currentUser);
  const changed = identityChanged || JSON.stringify(next) !== JSON.stringify(currentUser);

  currentUser = next;

  if (identityChanged) clearPrefetchCache();

  if (changed) for (const listener of [...listeners]) listener();
}

/** Test seam: back to a guest without notifying or clearing anything. */
export function resetSession(): void {
  currentUser = null;
  listeners.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SessionUser | null {
  return currentUser;
}

/**
 * Server-render seam. The SSR provider wraps the tree in
 * `<SessionContext.Provider value={{ user }}>`; on the client no provider is
 * mounted and `useUser()` reads the store.
 */
export const SessionContext = createContext<{ readonly user: SessionUser | null } | undefined>(
  undefined,
);

/** The signed-in user's projection, or `null` for a guest. Typed by `SessionRegistry`. */
export function useUser(): SessionUser | null {
  const provided = useContext(SessionContext);
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return provided !== undefined ? provided.user : stored;
}
