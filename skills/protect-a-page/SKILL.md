---
name: protect-a-page
description: "Guard a Web page and read the signed-in user with web.session, useUser, requireUser and requireGuest. Triggers: useUser, requireUser, requireGuest, safeRedirectTarget, SessionRegistry, web.session, pageSession, login redirect, guest-only page."
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
import { requireGuest, requireUser, useUser } from "@warlock.js/web";

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
