type Listener = () => void;

let currentTicket: symbol | undefined;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeNavigationPending(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readNavigationPending(): boolean {
  return currentTicket !== undefined;
}

/** The server never has a client navigation in flight. */
export function readNavigationPendingOnServer(): false {
  return false;
}

/**
 * Marks one router ticket as current and returns its opaque completion.
 * Replacing a ticket intentionally keeps the boolean snapshot true, so a
 * newer transition cannot produce a false pulse while it takes over.
 */
export function beginNavigationPending(): () => void {
  const ticket = Symbol("warlock.navigation.pending");
  const wasPending = currentTicket !== undefined;

  currentTicket = ticket;
  if (!wasPending) notify();

  return () => {
    if (currentTicket !== ticket) return;

    currentTicket = undefined;
    notify();
  };
}
