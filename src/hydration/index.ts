/**
 * The client entry: registry in, hydration out. No page names, no app paths.
 *
 * The page graph arrives from the Vite virtual module the build plugin serves,
 * so this file works for ANY page in ANY app. The previous version imported one
 * page and one layout by relative path into the monorepo's reference app, which
 * both hydrated every URL as the home page and made `@warlock.js/web`
 * uninstallable anywhere outside this checkout. Neither a page name nor an app
 * path appears here now, and nothing about the composition lives here either -
 * that is `buildHydratedTree`, which takes the registry as an argument and is
 * therefore testable without a bundler.
 */
import { createElement } from "react";
import { pages } from "virtual:warlock/pages";
import { buildHydratedTree } from "../client/build-hydrated-tree";
import { hydratePage } from "../client/hydrate-page";
import { NavigationRoot } from "../client/navigation/navigation-root";
import { publishRouteTable } from "../routing/route-table";

/*
  BEFORE the mount, not after: `<Link>` resolves its URL through the route table
  during render, and the first render is the hydration render. Publishing
  afterwards would make every anchor in the initial tree throw.

  The registry entries already carry `name` and `path` - the same pair the
  server registered its routes from, out of the same discovery result - so the
  browser's table cannot drift from the server's without the two being built
  from different page graphs, which hydration already refuses.
*/
publishRouteTable(pages, "hydration client entry");

/*
  The hydrated tree is wrapped in `NavigationRoot` so the page can be REPLACED
  later without a document load. The first render is still exactly the tree the
  server produced - `NavigationRoot` renders `initialTree` verbatim and adds no
  markup of its own - so hydration still matches the server byte for byte, and
  the wrapper only starts to matter on the first navigation.

  NO MRR HISTORY BRIDGE IS INSTALLED HERE YET, and that is a pending decision
  rather than an oversight. This runtime drives `window.history` itself and is
  complete without MRR. Handing history to `@mongez/react-router` as well means
  `@warlock.js/web` importing it, which puts MRR in the bundle of EVERY app that
  uses this package - a packaging choice (dependency vs. peer vs. app-level
  opt-in) with consequences for apps that never navigate through MRR. The bridge
  itself is written and documented in
  `conversations/2026-08-24-production-ssr-session.md`; it lands the moment that
  choice is made.
*/
hydratePage(async (payload) => {
  const tree = await buildHydratedTree(pages, payload);

  return createElement(NavigationRoot, {
    pages,
    initialPayload: payload,
    initialTree: tree,
    buildTree: buildHydratedTree,
  });
});
