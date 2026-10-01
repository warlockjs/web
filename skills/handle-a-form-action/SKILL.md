---
name: handle-a-form-action
description: "Handle a form POST on a page with an `action` (or named `actions`) export, `<Form>`, `useActionData`, `<FieldError>`, and `useIsSubmitting` from @warlock.js/web. Triggers: page action, action export, actions, <Form>, useActionData, FieldError, useIsSubmitting, config.action validation, response.redirect after POST, redactValues, no-JS form."
---

# Handle a form action

Use a page action when a form belongs to a page and the result should re-render it or redirect. To post to an API route from the browser, use the `submit-a-form` topic instead.

```tsx
import { Form, FieldError, useActionData, useIsSubmitting, href } from "@warlock.js/web";
import type { PageActionContext, PageConfig } from "@warlock.js/web";
import { v } from "@warlock.js/seal";

const contactSchema = v.object({ email: v.string().email() });

export const config: PageConfig = {
  route: { path: "/contact", name: "contact" },
  action: { validation: contactSchema },
};

export async function action({ request, response }: PageActionContext<typeof contactSchema>) {
  const { email } = request.validated();

  if (email === "blocked@example.com") return response.forbidden({ message: "Not allowed." });

  return response.redirect(href("contact"));
}

export default function Contact() {
  const result = useActionData<typeof action>();
  const pending = useIsSubmitting();

  return (
    <Form>
      <input name="email" defaultValue={result?.values?.email} />
      <FieldError name="email" />
      {result?.formErrors.map(message => <p key={message}>{message}</p>)}
      <button disabled={pending}>Send</button>
    </Form>
  );
}
```

## Rules
- Export `action` OR `actions` (a record), never both; page modules only. Policy goes in `config.action` / `config.actions.<name>` (`validation`, `middleware`), and the key must match an export.
- Several forms: `actions = { save, remove }`, `<Form action="remove">`. The name travels as the body field `_action`; names match `/^[a-z][a-zA-Z0-9]*$/`; `default` is reserved.
- Validation runs on the body only (files included); use `request.validated()`. Failure is a 422 `ActionState`, the action does not run.
- Return `response.redirect(url)`, data, or a failure helper: `badRequest`, `unauthorized`, `forbidden`, `conflict`, `unprocessableEntity`, `tooManyRequests`, each with optional `{ message, errors }`.
- Outcomes: no JS redirect is 303; JS redirect is 204 + `x-warlock-redirect`; failure is 422/4xx (page rendered at that status without JS, `actionData` body only with JS).
- `values` is echoed on failure only, never files, and omits names in `web.forms.redactValues` (default `password`, `password_confirmation`, `*token*`, `*secret*`). `web.forms.redactValues` is a typed config key of `readonly string[]`; set it at boot to replace that list (patterns support `*`).
- Same-origin `Origin`/`Referer` is always required (403 otherwise); no opt-out.
- Actions are never cached and always `private, no-store`; call `invalidatePageCache(tags)` to refresh other visitors' cached page.
- Redirect after success: a no-JS action that returns data re-POSTs on reload.
- `<Form>` defaults to `multipart/form-data`, so file inputs work; read them with `request.file(name)`.
- Per-user limit: `config.action.middleware: [middleware.rateLimit({ max: 5, duration: 60_000, key: "user", guests: "ip" })]` (`import { middleware } from "@warlock.js/core"`). Keyed on `request.locals.user.id`, so it needs `pageSession()` from `@warlock.js/auth`. `guests`: `"ip"` (default) or `"skip"`. Over the limit: 429, action not run.
- With `@mongez/react-form`, use `useSubmitAction` from `@warlock.js/web/form` and alias one of the two `Form`s.

## Set and clear a cookie, then redirect (sign in and out)

The action's `response` is the same buffered response a loader gets, plus the failure helpers. `cookie()`, `clearCookie()`, `header()` and `redirect()` are queued and committed with the reply, so an action can set a cookie and redirect in one step. Writes survive both a redirect and a failure; the cookie options are the core ones (`maxAge` in seconds, `path`, `httpOnly`, `sameSite`, `secure`, `raw`). See the `load-page-data` topic for the full response surface.

This example shows the cookie mechanics with an app-owned `signIn` service. For the framework's own session and a guarded page, see the `protect-a-page` topic.

```tsx title="src/web/login.page.tsx"
import { Form, FieldError, useActionData, useIsSubmitting } from "@warlock.js/web";
import type { PageActionContext, PageConfig } from "@warlock.js/web";
import { v } from "@warlock.js/seal";
import { signIn } from "app/accounts/services/sign-in.service";

const loginSchema = v.object({
  email: v.string().email(),
  password: v.string().minLength(8),
});

export const config = {
  route: { path: "/login", name: "login" },
  action: { validation: loginSchema },
} satisfies PageConfig;

export async function action({ request, response }: PageActionContext<typeof loginSchema>) {
  const { email, password } = request.validated();
  const token = await signIn(email, password); // app code: undefined for wrong credentials

  if (!token) {
    return response.unauthorized({ message: "Wrong email or password." });
  }

  response.cookie("session", token, { raw: true, maxAge: 60 * 60 * 24 * 7, path: "/" });

  return response.redirect("/account");
}

export default function LoginPage() {
  const result = useActionData<typeof action>();
  const pending = useIsSubmitting();

  return (
    <Form>
      <input name="email" type="email" defaultValue={result?.values?.email} />
      <FieldError name="email" />
      <input name="password" type="password" />
      <FieldError name="password" />
      {result?.formErrors.map((message) => <p key={message}>{message}</p>)}
      <button disabled={pending}>Sign in</button>
    </Form>
  );
}
```

Sign out is a second, named action on the page that owns the button. `clearCookie` must use the same `path` (and `domain`) the cookie was set with:

```tsx title="src/web/account.page.tsx"
import { Form } from "@warlock.js/web";
import type { PageActionContext, PageConfig } from "@warlock.js/web";

export const config = {
  route: { path: "/account", name: "account" },
} satisfies PageConfig;

export const actions = {
  async logout({ response }: PageActionContext) {
    response.clearCookie("session", { path: "/" });

    return response.redirect("/login");
  },
};

export default function AccountPage() {
  return (
    <Form action="logout">
      <button>Sign out</button>
    </Form>
  );
}
```

A sign-out button that lives on another page or in a layout posts to this action with `<Form to="account" action="logout">`: `to` is the route name of the page that owns the action.

- **Failure keeps the cookie writes too.** A failed sign-in that also called `response.cookie()` would still send it, so set the cookie only after the credentials check passes.
- **The password is never echoed.** `values` omits `password` by default (`web.forms.redactValues`), so only `email` is re-filled.
- **A response with a cookie is never cached.** It is `Cache-Control: private, no-store`, as every action response is.

## Validate in the browser with the same schema

Put browser-safe, shared constraints in a separate schema module. Import that one
constant into the page for `config.action.validation` and into the
`@mongez/react-form` form's `schema` prop:

```tsx
// src/web/contact/contact.schema.ts
import { v } from "@warlock.js/seal";

export const contactSchema = v.object({
  email: v.string().email(),
  message: v.string().min(10),
});
```

```tsx
// src/web/contact/contact.page.tsx
import { Form as ReactForm } from "@mongez/react-form";
import { useSubmitAction } from "@warlock.js/web/form";
import type { PageActionContext, PageConfig } from "@warlock.js/web";
import { contactSchema } from "./contact.schema";

export const config: PageConfig = {
  route: { path: "/contact", name: "contact" },
  action: { validation: contactSchema },
};

export async function action({ request, response }: PageActionContext<typeof contactSchema>) {
  const values = request.validated();
  // Handle values, then redirect or return data.
  return response.redirect("/contact");
}

export default function ContactPage() {
  const submit = useSubmitAction<typeof contactSchema>();

  return (
    <ReactForm method="post" schema={contactSchema} onSubmit={submit.submit}>
      {/* Your registered controls must be named "email" and "message". */}
    </ReactForm>
  );
}
```

`schema` provides immediate browser feedback, but `config.action.validation`
remains authoritative: a request that bypasses the browser is still rejected
with 422 before the action runs. `useSubmitForm` is for Core API routes; use
`useSubmitAction` for a page action. Keep database uniqueness checks and any
other server-only rule out of this shared schema: keep them server-side or
split the browser-safe constraints into a shared schema.
