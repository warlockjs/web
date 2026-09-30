---
name: protect-a-page
description: "Guard a Web page and read the signed-in user with web.session, useUser, requireUser and requireGuest. Triggers: useUser, requireUser, requireGuest, safeRedirectTarget, SessionRegistry, web.session, pageSession, login redirect, guest-only page, GuardedPageRouteName, guard: user, non-null user, useUser(routeName)."
---

# Protect a page

Wire the resolver once; web never imports auth.

```ts
// src/config/web.ts
import { pageSession } from "@warlock.js/auth";

export default { session: pageSession({ project: (user: User) => userSessionResource(user) }) };
```

`project` is required; only its result reaches the browser as the payload's optional `session` key. Type it by augmenting `SessionRegistry { user; model }` in module `"@warlock.js/web"`.

```tsx
import { useUser } from "@warlock.js/web";
import { requireGuest, requireUser } from "@warlock.js/web/session";

// account page
export const config = { route: "/account", middleware: [requireUser({ loginPath: "/login" })] };

// login page
export const config = { route: "/login", middleware: [requireGuest({ to: "/account" })] };
```

- `useUser()` returns the projection or `null`.
- A guest is redirected (302) to `loginPath?redirect=<url>`, locale-prefixed; `loginPath` defaults to `auth.pageAuth.loginPath`. A bearer (`Authorization`) request or no `loginPath` gives 401. A `userType` or `when` failure gives 403.
- Loader form: `const model = requireUser(ctx, options)`; `when` must be synchronous there.
- `requireGuest` sends a signed-in user to a safe `redirect` query, else `to` (default `/`). Use `safeRedirectTarget(value)` for any return URL.
- Signed-in pages are never page-cached; guests stay cacheable.
- Renewal is automatic (refresh cookie). Do not resolve the session from deferred work.
- After login or logout call `clearPrefetchCache()` before `navigateTo`/`refresh()`.
- Log in with `authService.loginWithSessionCookies`, which requires an Origin/Referer.

## Type a guarded page as signed-in

A page guarded by `requireUser()` can never be reached by a guest, so its types say so. The route-types generator reads the guard statically and writes `guard: "user"` on that page's `PageRouteRegistry` entry; `GuardedPageRouteName` (exported from `@warlock.js/web`) is the union of those names.

```tsx title="src/web/account/account.page.tsx"
import { useUser } from "@warlock.js/web";
import type { PageConfig, PageLoaderContext, PageProps } from "@warlock.js/web";
import { requireUser } from "@warlock.js/web/session";

export const config = {
  route: { path: "/account", name: "account.show" },
  middleware: [requireUser({ loginPath: "/login" })],
} satisfies PageConfig;

export async function loader({ session }: PageLoaderContext<undefined, undefined, "account.show">) {
  // session is { user, model } here, neither null, and request.locals.user is non-null
  return { user: session.user };
}

export default function AccountPage({ data }: PageProps<typeof loader>) {
  const user = useUser("account.show"); // SessionUser, never null

  return <h1>{user.name}</h1>; // assumes your SessionRegistry user has a name
}
```

- **Loader context.** `PageLoaderContext<Validation, typeof route>` (and `PageLoader`) type `session` as non-optional `{ user, model }` and `request.locals.user` as non-null for a guarded page. The route name comes from the third type argument as above, or from `typeof config.route` when `route` keeps a literal name: declare `config` `as const satisfies PageConfig`, because plain `satisfies` widens `name` to `string` and the loader then types `session` as optional. Layout and app loaders, page actions and unguarded pages are unchanged: there `session` is still optional and `user` may be `null`.
- **`useUser(routeName)`** returns a non-null `SessionUser`; any name that is not a guarded page fails to compile. Passing the name also keeps the last signed-in user while that component stays mounted, so a sign-out that flips the store to a guest a frame before navigation completes does not hand `null` to a component reading `user.name`. Plain `useUser()` is unchanged and still returns `null` for a guest.

### What counts as a guard (exact rule)

The page is typed as guarded only when the generator can prove it from source. The page, **any layout on its chain**, or the root (`root.tsx`) must export a **literal** `config` whose `middleware` is an **array literal** with a **direct element** that is a call `requireUser(...)`, where `requireUser` is a **value import** from `"@warlock.js/web/session"`. Arguments do not matter. An aliased import (`import { requireUser as ru }`) counts, and `as`/`satisfies`/parentheses around the array or the call are looked through. A page's `config` may live in its `.setup.ts` companion (in one of the two files, not both).

These do **not** count (the page stays unguarded in the types and `guard` is not emitted):

| Not a guard                                                          | Example                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| a spread into the array                                              | `middleware: [...guards]`                             |
| `middleware` that is not an array literal (identifier, call)        | `middleware: guards`                                  |
| a guard behind a conditional                                         | `middleware: [isPrivate ? requireUser() : audit]`     |
| a wrapper call around it                                             | `middleware: [withAudit(requireUser())]`              |
| an identifier in the array                                           | `middleware: [guard]`                                 |
| `requireGuest()`                                                     | `middleware: [requireGuest()]`                        |
| `config.action.middleware`                                           | only the page's action is guarded                     |
| a type-only import of `requireUser`, or one from any other module   | `import type { requireUser } ...`                     |
| a namespace or member call                                           | `session.requireUser()`                               |
| the loader form `requireUser(ctx)` inside a loader                   | it guards at runtime but is not seen by the generator |

The not-found page is never guarded. A guard the generator cannot prove still works at runtime; only the types stay loose (`useUser()` returns `null`-able).
In dev, a file the generator cannot parse reads as unguarded rather than breaking boot.
