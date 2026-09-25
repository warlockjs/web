import { useSyncExternalStore } from "react";

type Listener = () => void;

let currentTicket: symbol | undefined;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeSubmitting(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSubmitting(): boolean {
  return currentTicket !== undefined;
}

/** The server never has a client action in flight. */
export function readSubmittingOnServer(): false {
  return false;
}

/**
 * Marks one submit as the current in-flight action and returns its completion.
 * Replacing a ticket keeps the snapshot true, so a newer submit cannot pulse
 * `false` while it takes over.
 */
export function beginSubmitting(): () => void {
  const ticket = Symbol("warlock.action.submitting");
  const wasSubmitting = currentTicket !== undefined;

  currentTicket = ticket;
  if (!wasSubmitting) notify();

  return () => {
    if (currentTicket !== ticket) return;

    currentTicket = undefined;
    notify();
  };
}

/** Whether a page action submitted from this document is still in flight. */
export function useIsSubmitting(): boolean {
  return useSyncExternalStore(subscribeSubmitting, readSubmitting, readSubmittingOnServer);
}
