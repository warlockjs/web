---
name: render-client-only
description: 'Render browser-only UI with `<ClientOnly fallback={...}>` and `useIsClient()` — fallback on the server AND during hydration, children after mount, with no hydration mismatch. Covers the split between deferring RENDERING (what `<ClientOnly>` does) and deferring MODULE LOADING (what `React.lazy` does), and the combined pattern for a component whose module touches `window` at import time. Triggers: `ClientOnly`, `useIsClient`, "browser-only component", "hydration mismatch", "window is not defined", "text content does not match server-rendered HTML", `React.lazy` inside a page. Skip: SSR page/loader lifecycle — `@warlock.js/web/create-a-page/SKILL.md`; layout composition — `@warlock.js/web/use-layouts/SKILL.md`; competing primitives `next/dynamic` with `ssr: false`, `react-no-ssr`, a hand-rolled `typeof window !== "undefined"` guard around a whole component.'
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

## Gotchas

- **A plain child is already constructed.** `<ClientOnly>{someExpression}</ClientOnly>` evaluates `someExpression` before `<ClientOnly>` ever runs. Use the function-children form when the expression itself must not run on the server or during hydration.
- **`<ClientOnly>` cannot save a module with a top-level side effect.** If the module throws or touches `window` at import time, wrap the import in `React.lazy`, not just the render in `<ClientOnly>`.
- **Nothing inside `<ClientOnly>` renders during SSR.** Don't rely on it for SEO-relevant content — the fallback is what search engines and the initial paint see.
- **The fallback must be safe to render on the server.** It is not exempt from the usual SSR rules (no `window`, no browser-only APIs).

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — the page component this typically renders inside.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — the hydration boundary `<ClientOnly>`'s mount detection relies on.
