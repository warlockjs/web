---
name: measure-web-vitals
description: 'Report field Core Web Vitals (LCP, INP, CLS, plus FCP/TTFB) from the browser with the official `web-vitals` library and `navigator.sendBeacon`, attributed to the current route and device class. Covers where to register the reporter (`<ClientOnly>` / a root-level effect component, never module scope), why LCP/CLS are a HARD-load metric while INP accumulates for the whole session, tagging soft (client) navigations with `routerEvents`, and the p75 field thresholds that judge a route. Triggers: `web-vitals`, `onLCP`, `onINP`, `onCLS`, `onFCP`, `onTTFB`, `sendBeacon`, "Core Web Vitals", "RUM", "real user monitoring", "field data", "LCP too slow", "layout shift", "INP budget", "p75". Skip: lab/synthetic budgets and CI performance gates — a later addition; the `<Image>` component''s own API — read `web/src/image/types.ts`; client-only rendering mechanics — `@warlock.js/web/render-client-only/SKILL.md`; the root document shell — `@warlock.js/web/write-the-root/SKILL.md`.'
---

# Warlock — measure Web Vitals (field RUM)

Warlock sends **no telemetry of its own**. There is no built-in vitals
reporter, no bundled `web-vitals` dependency, and no server endpoint that
collects them — an app that wants Core Web Vitals data owns the whole path:
install `web-vitals`, register a reporter once on the client, and send the
numbers to an endpoint the app itself writes. This skill is that recipe, not
a framework feature.

## Install and register once

```
npm install web-vitals
```

The reporter must run exactly once per document, on the browser only, and
must not delay hydration or block the first render. That rules out module
scope in anything reachable from the server render — a page, layout, or
`root.tsx` module is [universal](../create-a-page/SKILL.md#the-client-boundary)
and evaluated during SSR, so `web-vitals`' own `window` access at call time
would need guarding anyway. The two supported places to call it:

**A root-level effect component rendered inside `#vessel`.** Add a small
client component to `root.tsx` (below `#vessel`, so it hydrates with the
rest of the tree) that fires the registration from a `useEffect`:

```tsx title="src/web/vitals-reporter.tsx"
import { useEffect } from "react";

export function VitalsReporter() {
  useEffect(() => {
    import("./report-web-vitals").then(({ reportWebVitals }) => reportWebVitals());
  }, []);

  return null;
}
```

```tsx title="src/web/root.tsx"
import { Head, Scripts } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";
import { VitalsReporter } from "./vitals-reporter";

export default function App({ children }: AppProps) {
  return (
    <html lang="en">
      <head>
        <Head />
      </head>
      <body>
        <div id="vessel">
          {children}
          <VitalsReporter />
        </div>
        <Scripts />
      </body>
    </html>
  );
}
```

A dynamic `import()` inside the effect keeps `web-vitals` itself out of the
server bundle and out of the initial client chunk — it only downloads once
the page has already hydrated, which matters because the reporter must never
compete with the page's own critical path for bandwidth.

**Or `<ClientOnly>`**, if reporting lives next to other client-only widgets
rather than the root — see
[render-client-only](../render-client-only/SKILL.md). Either placement is
fine; what matters is that the `web-vitals` import and every `on*` call stay
inside a client-only effect, never at module scope, and that the effect has
an empty dependency array so it fires exactly once per document.

## The report function

```ts title="src/web/report-web-vitals.ts"
import { onLCP, onINP, onCLS, onFCP, onTTFB } from "web-vitals";
import { currentRoute, routerEvents } from "@warlock.js/web";
import type { Metric } from "web-vitals";

function deviceClass(): "mobile" | "desktop" {
  return window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop";
}

let navigationType: "hard" | "soft" = "hard";
let softRouteName: string | undefined;

function send(metric: Metric) {
  const route = currentRoute();

  const body = JSON.stringify({
    name: metric.name, // "LCP" | "INP" | "CLS" | "FCP" | "TTFB"
    value: metric.value,
    id: metric.id, // stable per-metric-instance id — dedupe repeated INP entries on it
    rating: metric.rating, // "good" | "needs-improvement" | "poor", web-vitals' own thresholds
    route: navigationType === "hard" ? route?.name : softRouteName,
    navigationType,
    device: deviceClass(),
    url: location.href,
  });

  navigator.sendBeacon("/api/vitals", body);
}

export function reportWebVitals() {
  onLCP(send);
  onINP(send);
  onCLS(send);
  onFCP(send);
  onTTFB(send);

  routerEvents.onNavigated(() => {
    navigationType = "soft";
    softRouteName = currentRoute()?.name;
  });
}
```

`/api/vitals` is an ordinary application API route — write it like any other
route and store or forward the beacon body; nothing about it is
Warlock-specific.

- `currentRoute()` (`@warlock.js/web`) returns `{ name, params? }` for
  whatever the SERVER matched for the page on screen, or `undefined` before
  any page has rendered into the module. It is correct from the very first
  render — the initial document's hydration payload already carries the
  match — so a hard-load metric can always attribute to a route name.
- `routerEvents.onNavigated(callback)` (`@warlock.js/web`) fires after a
  client (soft) navigation's tree swap commits. It is how you learn the
  route changed WITHOUT a new document load — see
  [Soft navigations](#soft-navigations-and-attribution) below for why this
  matters for attribution.
- `sendBeacon` fires-and-forgets even as the page is unloading, which is why
  it — not `fetch` — is the standard transport for vitals: a `fetch` call
  started during `visibilitychange`/`pagehide` can be cancelled by the
  browser before it lands, `sendBeacon` cannot.
- Device class here is a `matchMedia` breakpoint as a placeholder — use
  whatever the app already has (a `User-Agent` server hint, a viewport
  bucket, `navigator.connection?.effectiveType`). Warlock has no device-class
  API of its own; this is entirely app logic.

## Soft navigations, and attribution

`web-vitals` reports **per hard page load** — LCP and CLS are computed once
for the document that was actually loaded from the network, because both are
defined relative to a navigation's own paint timeline and layout history. A
Warlock client navigation (`<Link>`, `navigateTo()`, `refresh()`) never
reloads the document — it fetches page data and swaps the tree
([navigate-on-the-client](../navigate-on-the-client/SKILL.md)) — so LCP and
CLS keep firing for the route the visitor HARD-landed on, not whatever route
is on screen ten client navigations later. `web-vitals` has no way to know a
Warlock soft navigation happened at all; it only watches the DOM and the
paint timeline of the one document it was loaded into.

**INP is different.** It is a whole-session metric — the single worst
interaction across the page's entire lifetime — so it keeps accumulating
across every soft navigation on that document and reports once, late (on
visibility change / page hide), attributed to wherever `currentRoute()`
happens to point at that moment.

So the attribution rule the recipe above encodes:

- **LCP and CLS**: attribute to the route the visitor hard-landed on
  (`navigationType: "hard"`, `route: currentRoute()?.name` read at
  registration time — this is fixed for the metric's whole life, because the
  metric itself never moves off that document).
- **INP**: attribute to whichever route was current when it finally reports,
  tracked by `routerEvents.onNavigated` between hard load and report time —
  `navigationType: "soft"` says the number may reflect interactions on a
  route the visitor navigated to AFTER the hard load, not necessarily the one
  it's reported against.

Do not try to make LCP/CLS "follow" the soft-navigated route — that would
misattribute a metric that is, by definition, about the document's initial
load to a route the browser never actually loaded as a document. If
per-soft-navigation LCP/CLS matters to the app, that is a separate,
harder problem (a manual "soft LCP" using `PerformanceObserver` yourself)
outside what `web-vitals` gives you for free.

## Thresholds — judge at p75, per route and device

Google's Core Web Vitals thresholds are field percentiles, not single-sample
pass/fail:

| Metric | Good (p75) |
| ------ | ---------- |
| LCP    | ≤ 2.5s     |
| INP    | ≤ 200ms    |
| CLS    | ≤ 0.1      |

Compute the **75th percentile of collected samples, grouped by route name and
device class**, before comparing to these numbers — a single fast or slow
sample means nothing, and mixing mobile with desktop or one route with
another hides the route that's actually failing behind ones that are fine.
This is why `route` and `device` are on every beacon above: they're the
group-by keys the aggregation needs, not decoration.

**Field RUM is the ground truth for these three.** A lab tool (Lighthouse,
`WebPageTest`) cannot measure INP at all — it has no real user interaction to
time — so a lab run substitutes **Total Blocking Time (TBT)** as a proxy for
input responsiveness. TBT correlates with INP but is not it; treat lab
numbers as a pre-deploy smell test, and treat the p75 field numbers above as
the number that decides whether a route is actually fast for visitors. (Lab
budgets and a CI performance gate are a separate, later addition — not
covered here.)

## Practices that move these numbers

**Images — the `<Image>` component (`@warlock.js/web`).** Always pass
`image.width`/`image.height` (or let `<Image>` read them off the
`ImageDescriptor`) — it renders `width`/`height` on the `<img>` itself, which
is what reserves layout space before the image decodes and is the single
biggest CLS win available. Pass `priority` only on the page's actual LCP
image — it flips `loading` to `"eager"` and sets `fetchPriority="high"`,
which is right for exactly one image per page and wrong (it competes for
bandwidth with the real LCP candidate) for every other one. Every image is
`loading="lazy"` by default unless `priority` says otherwise — do not add a
blanket `loading="eager"` override.

**Fonts.** Preload the page's above-the-fold webfont with a `<link
rel="preload" as="font">` in `root.tsx`'s `<head>` (beside `<Head />`, which
does not manage this), and set `font-display: swap` (or `optional`, if a
layout jump on late font-swap matters more than showing text immediately) in
the `@font-face` rule. Both aim at LCP text and CLS from font-swap reflow,
not at INP.

**CSS.** Only imported stylesheets are supported —
[create-a-page](../create-a-page/SKILL.md#static-assets-use-public)'s static
asset rule and [serve-styles](../serve-styles/SKILL.md) cover the mechanics.
Canon: no inline `<style>` tags — imported CSS is what the framework's
stylesheet pipeline can dedupe, cache and ship as a real `<link>`, which
matters for LCP because it lets the browser start the CSS fetch as early and
as cacheably as possible.

**Hydration.** Keep the client bundle small — every byte the browser must
parse and execute before it can respond to input is a direct INP cost. Wrap
non-critical widgets (a chat launcher, a "recently viewed" rail) in
[`<ClientOnly>`](../render-client-only/SKILL.md) paired with `React.lazy`, so
their code does not even download until after the page has hydrated, rather
than merely deferring when it _renders_.

**Suspense / `defer()`.** A [deferred](../stream-deferred-data/SKILL.md)
section's `<Suspense>` fallback IS the layout that section occupies until the
real content arrives — size the fallback (a skeleton with the same
dimensions the resolved content will have) rather than leaving it collapse
to nothing, or the swap from fallback to content is a CLS hit you deferred
the data specifically to avoid.

**Third-party scripts.** A synchronous third-party `<script>` in `root.tsx`'s
`<head>` blocks the main thread during the exact window LCP and INP are
measured in. Load it after first interaction (a `pointerdown`/`keydown`
listener that inserts the script tag), or defer it to a page's own
`<ClientOnly>` widget so it never ships in the initial hydration bundle at
all.

## Gotchas

- **Warlock ships no reporter and no collection endpoint.** `web-vitals`,
  the registration effect, and `/api/vitals` (or wherever the app sends
  beacons) are all application code.
- **Never call `web-vitals`' `on*` functions at module scope.** A page,
  layout, or `root.tsx` module is evaluated during SSR; `window` access there
  crashes the server render. Register from an effect, per
  [render-client-only](../render-client-only/SKILL.md).
- **LCP and CLS do not move with a soft navigation.** They stay attributed
  to the route the visitor hard-landed on; only INP's late report should be
  tagged with whatever `routerEvents.onNavigated` last saw.
- **A single sample is not a verdict.** Aggregate to p75 per route and per
  device class before comparing to the 2.5s / 200ms / 0.1 thresholds.
- **Lab tools cannot measure INP.** Treat a lab TBT number as a proxy signal
  before deploy, and the field p75 as the number that actually matters.

## See also

- [`render-client-only/SKILL.md`](../render-client-only/SKILL.md) — the
  `<ClientOnly>` / `useIsClient` primitive the reporter registration relies
  on.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — `root.tsx` and
  `#vessel`, where a root-level reporter component is placed.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) —
  `Link`, `navigateTo()`, `refresh()`: what makes a navigation "soft".
- [`stream-deferred-data/SKILL.md`](../stream-deferred-data/SKILL.md) —
  `defer()` and `<Suspense>`, relevant to the CLS guidance above.
