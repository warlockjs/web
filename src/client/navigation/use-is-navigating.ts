import { useSyncExternalStore } from "react";
import {
  readNavigationPending,
  readNavigationPendingOnServer,
  subscribeNavigationPending,
} from "./navigation-pending-store";

/** Whether the current client router ticket is still in flight. */
export function useIsNavigating(): boolean {
  return useSyncExternalStore(
    subscribeNavigationPending,
    readNavigationPending,
    readNavigationPendingOnServer,
  );
}
