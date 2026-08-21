// Gate C bypass fixture (Part 1, item 3): built with ONLY gateCVerify() in
// the plugin array — Gate A is deliberately absent, so this import into a
// server-only governed-scope package reaches the bundle for real. Gate C
// alone must still catch the resulting import edge in the module graph.
import { secretServerThing } from "@warlock.js/fake-server-pkg";

export default function LeakedImportEdgePage() {
  return secretServerThing;
}
