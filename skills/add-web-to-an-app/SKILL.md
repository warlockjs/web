---
name: add-web-to-an-app
description: 'Install the SSR page layer with `warlock add web`: add React/Vite peers, scaffold `src/web/root.tsx` and `src/web/home.page.tsx`, register `webConnector()`, and safely relocate the stock top-level `GET "/"` JSON route to `/welcome`. Triggers: `warlock add web`, `webConnector`, `src/web/root.tsx`, `src/web/home.page.tsx`, `GET "/welcome"`; "add web to an app", "install Warlock web", "scaffold SSR", "homepage route collision". Skip: author a page — `@warlock.js/web/create-a-page/SKILL.md`; customize the document — `@warlock.js/web/write-the-root/SKILL.md`; dev/build/start commands — `@warlock.js/core/run-app/SKILL.md`; competing installers `create-next-app`, `vite create`, `remix init`.'
---

# Warlock — add web to an app

`warlock add web` turns an existing Warlock API application into an application that can also serve SSR React pages. It installs the web and React packages, adds the Vite development peers, scaffolds the smallest page layer, and registers the late-phase web connector.

## The shape

```bash
pnpm warlock add web
```

On the ordinary path it leaves this application-owned shape:

```text
src/
  web/
    root.tsx
    home.page.tsx
warlock.config.ts
```

The generated home page declares `route = "/"`. The generated root owns the document, renders `<Head />`, keeps `{children}` inside `#root`, and renders `<Scripts />`.

## Connector registration

The command adds `webConnector()` to `warlock.config.ts`. If the config cannot be patched safely, add the same wiring yourself:

```ts title="warlock.config.ts"
import { defineConfig } from "@warlock.js/core";
import { webConnector } from "@warlock.js/web/connector";

export default defineConfig({
  connectors: [webConnector()],
});
```

Keep the connector in `warlock.config.ts`. The build reads this same array to collect web's build contribution, while dev/start use it to boot the runtime. Registering it again from `src/app/main.ts` boots it twice and duplicates page routes.

## What happens to an existing `GET "/"`

The stock project template already owns `/` with a JSON welcome route. The page stub also owns `/`, and two `GET` handlers for one path fail at request time. The installer preserves both surfaces by changing the existing JSON route to `/welcome` before it writes the page.

The automatic move is intentionally narrow. It only inspects:

```text
src/app/shared/routes.ts
```

and only rewrites exactly one top-level declaration shaped like this:

```ts
router.get("/", homePageController);
```

After the move:

```ts
router.get("/welcome", homePageController);
```

Indented `router.get("/", ...)` declarations inside a prefixed group are not root collisions and are not touched.

## Collision outcomes

- No `src/app/shared/routes.ts`, or no top-level `GET "/"`: create the root page normally.
- Exactly one recognized top-level `GET "/"` and no top-level `GET "/welcome"`: move it to `/welcome`, then create the home page.
- More than one top-level `GET "/"`, an existing top-level `GET "/welcome"`, an unreadable/unwritable routes file, or an unrecognized rewrite: create `root.tsx`, do not create `home.page.tsx`, set a failing exit code, and still register the connector.

On the refusal path, free `/` yourself and create a page with either `route = "/"` or another literal route.

## Re-running the command

`src/web/root.tsx` is the scaffold sentinel. If it already exists, the command skips the `src/web` scaffold rather than overwriting a human-owned root. Connector registration is independently idempotent: if the config already mentions `webConnector`, it is left alone.

## Verify the result

Read the files rather than assuming the command could patch every application shape:

```bash
pnpm warlock routes --method GET --path /
pnpm warlock routes --method GET --path /welcome
```

The desired result is one page route at `/` and, when the stock JSON route existed, one API route at `/welcome`.

## Gotchas

- **The collision scan is not codebase-wide.** A root route declared outside `src/app/shared/routes.ts` is not moved. Check `warlock routes` after installation.
- **`/welcome` must be free before relocation.** The installer refuses to trade one duplicate route for another.
- **A partial scaffold exits non-zero.** `root.tsx` and connector registration may still have been written; complete only the missing home page after resolving the collision.
- **Do not register the connector twice.** Use `warlock.config.ts`, not an additional `connectorsManager.register(...)` call.
- **Do not import the hydration entry.** The connector and build contribution own it.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — write the page after installation.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — customize the generated document shell.
- [`serve-styles/SKILL.md`](../serve-styles/SKILL.md) — add global CSS from the root.
- [`@warlock.js/core/run-app/SKILL.md`](@warlock.js/core/run-app/SKILL.md) — run dev, build, and production.
