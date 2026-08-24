/**
 * The APP ROOT fixture for Gate A.
 *
 * Nothing built a root file through the gate before this fixture existed. The
 * root at `.../src/web/root.tsx` is admitted by the `web/` FOLDER rule —
 * `isRecognizedUniversalSurface` carries no name branch for it — so what this
 * pins is the property, not the rule: the root must build, and must keep its
 * universal import while doing so.
 */
import { appLabel } from "./universal-helper";

export default function App({ children }: { children?: unknown }) {
  return [appLabel, children];
}
