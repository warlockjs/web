// Case 6: the page module itself is clean; the secret read is one hop
// away, inside a helper it imports — must still fail.
import { readSecret } from "./case6-helper";

export default function Case6Page() {
  return readSecret();
}
