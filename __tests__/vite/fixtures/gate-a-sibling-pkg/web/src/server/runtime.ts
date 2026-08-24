// Deliberately lives OUTSIDE the fixture app root, at the exact path shape
// `@warlock.js/web` has in this monorepo (`web/src/server/**`). Reached as a
// workspace sibling rather than through node_modules, so it exercises the
// other half of the app-source scoping: outside `appRoot` is never app source.
import { siblingServerHelper } from "./helper";

export const siblingServerValue = siblingServerHelper();
