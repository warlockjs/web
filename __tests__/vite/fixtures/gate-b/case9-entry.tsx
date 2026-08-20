// Case 9: this fixture "app" has two PUBLIC_* env vars declared at build
// time — PUBLIC_READ_VAR and PUBLIC_UNREAD_VAR — but only PUBLIC_READ_VAR is
// read anywhere in the client-bound modules (this file plus case9-helper.ts).
// PUBLIC_UNREAD_VAR's value must not end up inlined in the emitted bundle.
import { helperGreeting } from "./case9-helper";

export default function Case9Component() {
  return `${helperGreeting()}: ${import.meta.env.PUBLIC_READ_VAR}`;
}
