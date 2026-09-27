---
name: observe-page-requests
description: 'Observe SSR page request phases through core `TracingHooks`: page middleware, cache lookup, loader/render streaming, and deferred-value settlement. Triggers: `page.middleware`, `page.cache`, `defer.settle`, `render.shell`, `TracingHooks`, `http.tracing`; "trace a page request", "page cache telemetry", "deferred stream observability".'
---

# Observe page requests

Web emits page spans through core's `TracingHooks.onPhase`; there is no
web-specific tracing API. Configure or register the hook as documented in
[`@warlock.js/core/request-tracing/SKILL.md`](@warlock.js/core/request-tracing/SKILL.md).

```ts
import { registerTracingHooks } from "@warlock.js/core";

registerTracingHooks({
  onPhase(_ctx, phase) {
    if (phase.name === "page.cache") {
      console.log(phase.attrs?.status); // hit | miss | bypass
    }
  },
});
```

## Page-specific phases

| Phase             | Attributes                   | Meaning                                            |
| ----------------- | ---------------------------- | -------------------------------------------------- |
| `page.middleware` | `count`, `outcome` (`next`   | `response`                                         | `error`)                           | All page middleware settling |
| `page.cache`      | `status` (`hit`              | `miss`                                             | `bypass`)                          | Page-cache lookup settling   |
| `loader`          | `level`, `layoutPath?`       | An app, layout, or page loader                     |
| `render.shell`    | —                            | Rendering until React's shell is ready to stream   |
| `stream.end`      | —                            | Whole streamed response, including deferred values |
| `defer.settle`    | `key`, `status` (`fulfilled` | `rejected`)                                        | One deferred loader value settling |

Every phase has `name`, `durationMs`, and `startedAt` (epoch milliseconds).
Use `key` only to identify a deferred value; do not put sensitive loader data
in tracing attributes.
