/**
 * The APP ROOT fixture, and the only fixture here whose FILENAME is the thing
 * under test.
 *
 * `isProjectableFile` recognises a root by exact basename, not by a suffix the
 * way it recognises `*.page.tsx`. Every other fixture in this directory would
 * still be projected if that branch were deleted; this one would not. It exists
 * so the branch has something that fails when it stops working — before this
 * file, no test ever put a root id through the transform at all, and the one
 * test whose title named the root only ran `helper.ts`.
 *
 * It carries the server exports a real root carries — `middleware`, `loader`
 * and `revalidate` — because the point is not that the file is transformed but
 * that those exports do not survive into the browser bundle.
 */
import { serverSecret } from "./server-only-helper";
import { sharedValue } from "./helper";

export const middleware = [() => serverSecret];

export const loader = async () => ({ appName: sharedValue });

export const revalidate = false;

export default function App({ children }: { children?: unknown }) {
  /*
    The component USES `sharedValue`, which is the whole point of importing it
    here: `./helper` is shared between a stripped server export and the
    surviving component, so projection must keep it. `./server-only-helper`
    feeds only `middleware` and must go. One fixture, both directions.
  */
  return [sharedValue, children];
}
