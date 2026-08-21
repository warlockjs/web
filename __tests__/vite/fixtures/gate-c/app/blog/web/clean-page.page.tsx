// Gate C positive fixture (Part 1): a normal page through the FULL composed
// `warlockClientBoundary()` pipeline — projection strips `loader` (and the
// now-orphaned @warlock.js/core import) before Gate A or Gate C ever see it.
// Gate C must not false-positive on a legitimately clean emitted bundle.
import { database } from "@warlock.js/core";

export const loader = async () => {
  return { title: await database.find() };
};

export default function CleanPage() {
  return "clean page";
}
