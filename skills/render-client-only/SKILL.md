---
name: render-client-only
description: 'Render browser-only UI with `<ClientOnly fallback={...}>` and `useIsClient()` — fallback on the server AND during hydration, children after mount, with no hydration mismatch. Covers the split between deferring RENDERING (what `<ClientOnly>` does) and deferring MODULE LOADING (what `React.lazy` does), and the combined pattern for a component whose module touches `window` at import time. Also a debug checklist for pages that look right then break after hydration (what Warlock logs, the usual mismatch causes) and the `onClientError` hook. Triggers: `ClientOnly`, `onClientError`, `useIsClient`, "browser-only component", "hydration mismatch", "window is not defined", "page flashes then changes after load", "buttons dead after load", "report client errors", "text content does not match server-rendered HTML", `React.lazy` inside a page. Skip: SSR page/loader lifecycle — the `create-a-page` topic; layout composition — the `use-layouts` topic; competing primitives `next/dynamic` with `ssr: false`, `react-no-ssr`, a hand-rolled `typeof window !== "undefined"` guard around a whole component.'
---

# Warlock — render client-only content

Some UI can only run in a browser — it reads `window`, `localStorage`, a
canvas, a third-party widget that assumes a DOM. `<ClientOnly>` renders a
server-safe placeholder for that UI and swaps to the real thing once the page
has mounted, without ever producing a hydration mismatch.

## The shape

```tsx
import { ClientOnly } from "@warlock.js/web";

function LastVisited() {
  return (
    <ClientOnly fallback={<span>—</span>}>
      <span>{window.localStorage.getItem("lastVisited") ?? "first visit"}</span>
    </ClientOnly>
  );
}
```

- `fallback` renders on the server, AND on the client's hydration render. It defaults to `null`.
- `children` renders once the page has mounted in the browser — after hydration has already matched the server markup, never during it.
- `children` may also be a function, `() => ReactNode`, for code that must not run at all until the browser render:

```tsx
<ClientOnly fallback={<p>Loading map…</p>}>
  {() => <Map center={window.localStorage.getItem("lastCenter")} />}
</ClientOnly>
```

The plain-node form and the function form differ only in WHEN the expression inside them runs. `<span>{window.foo}</span>` as a plain child is already constructed — `window.foo` was read — by the time it reaches `<ClientOnly>`; wrap it in a function when reading `window` must wait for the browser render too, not just the visible output.

## `useIsClient()`

The hook `<ClientOnly>` is built on, for cases that need the boolean directly rather than a fallback/children split:

```tsx
import { useIsClient } from "@warlock.js/web";

function ThemeToggle() {
  const isClient = useIsClient();
  return <button disabled={!isClient}>Toggle theme</button>;
}
```

`false` on the server and during the hydration render; `true` from the next render onward, once mounted. Never branches on `typeof window` — the initial value is a constant, so the server pass and the client's hydration pass return the identical thing by construction, and the flip to `true` only happens on a render React triggers AFTER hydration has already reconciled.

## This defers RENDERING, not MODULE LOADING

**The trap:** `<ClientOnly>` decides what gets RENDERED. It has no say over what gets IMPORTED. A normal `import` statement runs at module-load time, wherever that module is reached from in the import graph — including the server, if the file that imports it is part of the page's server bundle.

The widget and its fallback, shared by every example below:

```tsx title="src/web/widgets/browser-only-widget.tsx"
export default function BrowserOnlyWidget() {
  return <span>{window.localStorage.getItem("lastVisited") ?? "first visit"}</span>;
}
```

```tsx title="src/web/widgets/placeholder.tsx"
export default function Placeholder() {
  return <span>Loading…</span>;
}
```

```tsx title="src/web/widgets/broken.page.tsx"
// ❌ still breaks the server render
import BrowserOnlyWidget from "./browser-only-widget"; // this import runs on the SERVER too,
                                                         // and if browser-only-widget.tsx touches
                                                         // `window` at its top level, the server
                                                         // render throws before ClientOnly ever
                                                         // gets a chance to hide it.

import { ClientOnly } from "@warlock.js/web";
import Placeholder from "./placeholder";

export default function Page() {
  return (
    <ClientOnly fallback={<Placeholder />}>
      <BrowserOnlyWidget />
    </ClientOnly>
  );
}
```

`<ClientOnly>` only controls whether the already-imported `<BrowserOnlyWidget />` element gets rendered. The module behind it was already evaluated, top-level `window` access and all, the moment the page module itself was loaded.

**The fix:** make the import itself lazy with `React.lazy`, so the dynamic `import()` only fires the first time the lazy component is actually rendered. Paired with `<ClientOnly>`, that render never happens on the server, so the import never happens on the server either:

```tsx title="src/web/widgets/lazy.page.tsx"
// ✅ the import is deferred, not just the render
import { lazy } from "react";
import { ClientOnly } from "@warlock.js/web";
import Placeholder from "./placeholder";

const BrowserOnlyWidget = lazy(() => import("./browser-only-widget"));

export default function Page() {
  return (
    <ClientOnly fallback={<Placeholder />}>
      <BrowserOnlyWidget />
    </ClientOnly>
  );
}
```

`React.lazy` components suspend, so give `<ClientOnly>`'s subtree a `<Suspense>` boundary if the lazy chunk might not be cached yet:

```tsx title="src/web/widgets/lazy-suspense.page.tsx"
import { lazy, Suspense } from "react";
import { ClientOnly } from "@warlock.js/web";
import Placeholder from "./placeholder";

const BrowserOnlyWidget = lazy(() => import("./browser-only-widget"));

export default function Page() {
  return (
    <ClientOnly fallback={<Placeholder />}>
      <Suspense fallback={<Placeholder />}>
        <BrowserOnlyWidget />
      </Suspense>
    </ClientOnly>
  );
}
```

## The page looks right, then breaks after hydration

A hydration mismatch means the markup React builds in the browser is not the markup the server sent. React recovers by discarding the server HTML for the affected boundary and rendering it again on the client, so the symptom is a flash, a layout jump, lost scroll or input state, or a widget that never works, rather than a crash. Anything that renders differently on the server and in the browser's first render is a cause.

### What Warlock logs, and where

Warlock wires React's `hydrateRoot` error hooks into one reporting function (`hydrate-page.tsx`). Open the browser console (not the terminal; this happens in the browser) and look for:

- `[warlock:web] React recovered from a hydration mismatch:` followed by React's own error. A mismatch React fixed by re-rendering on the client. In development React's message names the element and shows a server/client diff; a production build prints a minified React error code you can look up at react.dev/errors.
- `[warlock:web] an uncaught error reached hydration with no boundary:`. An error thrown during the hydration render that no boundary caught.
- `[warlock:web] an error was caught by an app boundary:`. An `ErrorBoundary` you wrote caught a hydration-render error.
- `[warlock:web] an uncaught window error:` and `[warlock:web] an unhandled promise rejection:`. Plain browser errors, for example from an effect or a third-party script.

Each is a `console.error` that cannot be switched off. If you also register `onClientError` (below), the same events reach your callback.

### Checklist of causes

Work down the list; each item is something that makes the first client render differ from the server render.

1. **Time and randomness in render.** `new Date()`, `Date.now()`, `Math.random()` or an id from either. Take the value from loader data (it is computed once, on the server, and shipped), or compute it after mount.
2. **Locale and timezone formatting.** `toLocaleString()`, `toLocaleDateString()` and `Intl.*` with no explicit arguments use the *runtime's* locale and timezone, which differ between the server process and the visitor's browser. Pass an explicit `timeZone` and the page's locale (`useLocale()`), or format the string in the loader. Never derive page text from `navigator.language`.
3. **Browser-only APIs during render.** `window`, `document`, `localStorage`, `matchMedia`, `navigator`, `innerWidth`. A `typeof window !== "undefined"` branch in render is the same bug: the server takes one side and the client's first render the other. Use `<ClientOnly>` or `useIsClient()` (both above), or read the API in `useEffect`.
4. **`useId` shifting.** `useId()` is hydration-safe, but its values come from position in the tree, so a component that renders on the client's first pass and not on the server (for example behind a `typeof window` check) moves every id after it. Fix the branch, not the id. Do not replace it with `Math.random()`.
5. **Invalid HTML nesting.** `<div>` or `<ul>` inside `<p>`, `<a>` inside `<a>`, `<tr>` directly inside `<table>`, `<form>` inside `<form>`. The browser's HTML parser repairs the server markup before React sees it, so the DOM React hydrates is not what the server rendered. Compare "View page source" (what the server sent) with the Elements panel (what the parser made).
6. **Browser extensions and injected scripts.** Translators, password managers, dark-mode and ad-blocking extensions, and third-party scripts add attributes or nodes inside `#vessel`. Reproduce in a private window with extensions off before changing code.
7. **State read from the URL or the match.** `useQueryString` is safe (it reads the request's search string on the server). `currentRoute()` and `previousRoute()` are `undefined` during the server render; branching on them in markup is a mismatch unless you gate with `useIsClient()`.
8. **Nothing hydrates at all** (links and buttons are dead, no mismatch message). Check that `root.tsx` renders `<Scripts />` after `#vessel`, that `{children}` is inside exactly one `id="vessel"` element, that the client entry script request is not blocked (a strict Content-Security-Policy without the request nonce shows a violation in the console), and that no module's `register()` throws. See the `write-the-root` topic.

To find the culprit quickly, wrap the suspect subtree in `<ClientOnly fallback={...}>`. If the message disappears, the subtree reads something the server cannot know; then decide whether to keep it client-only or move the value into loader data.

### `onClientError`: send these errors to your own sink

`onClientError(reporter)` is exported from `@warlock.js/web`. Warlock has no built-in error beacon or endpoint; this is the hook for yours.

```ts
type ClientErrorKind = "window-error" | "unhandled-rejection" | "hydration" | "boundary";

type ClientErrorEvent = {
  error: unknown;
  kind: ClientErrorKind;
  /** The current route's name, when it is known at report time. */
  routeName?: string;
  /** `window.location.pathname` at report time. */
  pathname?: string;
};

function onClientError(reporter: (event: ClientErrorEvent) => void | Promise<void>): void;
```

Register it once, in the browser, before hydration. A root `register()` hook runs on the server and in the browser before the first client render, so guard it with `typeof window`:

```ts title="src/web/root.setup.ts"
import { onClientError, type RootConfig } from "@warlock.js/web";

export const config: RootConfig = { strictMode: true };

export function register() {
  if (typeof window === "undefined") return;

  onClientError(({ error, kind, routeName, pathname }) => {
    const body = JSON.stringify({
      kind,
      routeName,
      pathname,
      message: error instanceof Error ? error.message : String(error),
    });

    navigator.sendBeacon("/api/client-errors", body);
  });
}
```

Rules that follow from the source:

- There is exactly one active reporter; calling `onClientError` again **replaces** the previous one.
- The `console.error` line is written first, always; your callback is in addition to it, never instead.
- The same error object reaches your callback at most once, even if several paths report it.
- A throw or rejection inside your callback is logged once and is not fed back into the reporter, so a broken reporter cannot loop.
- `register()` must be synchronous. Keep the callback itself small and do the network work inside it.

## Gotchas

- **A plain child is already constructed.** `<ClientOnly>{someExpression}</ClientOnly>` evaluates `someExpression` before `<ClientOnly>` ever runs. Use the function-children form when the expression itself must not run on the server or during hydration.
- **`<ClientOnly>` cannot save a module with a top-level side effect.** If the module throws or touches `window` at import time, wrap the import in `React.lazy`, not just the render in `<ClientOnly>`.
- **Nothing inside `<ClientOnly>` renders during SSR.** Don't rely on it for SEO-relevant content — the fallback is what search engines and the initial paint see.
- **The fallback must be safe to render on the server.** It is not exempt from the usual SSR rules (no `window`, no browser-only APIs).

## See also

- The `create-a-page` topic: the page component this typically renders inside.
- The `write-the-root` topic: the hydration boundary `<ClientOnly>`'s mount detection relies on.
