---
name: handle-a-form-action
description: "Handle a form POST on a page with an `action` (or named `actions`) export, `<Form>`, `useActionData`, `<FieldError>`, and `useIsSubmitting` from @warlock.js/web. Triggers: page action, action export, actions, <Form>, useActionData, FieldError, useIsSubmitting, config.action validation, response.redirect after POST, redactValues, no-JS form."
---

# Handle a form action

Use a page action when a form belongs to a page and the result should re-render it or redirect. To post to an API route from the browser, use `submit-a-form.md` instead.

```tsx
import { Form, FieldError, useActionData, useIsSubmitting, href } from "@warlock.js/web";
import type { PageActionContext, PageConfig } from "@warlock.js/web";
import { v } from "@warlock.js/seal";

export const config = {
  route: { path: "/contact", name: "contact" },
  action: { validation: v.object({ email: v.string().email().required() }) },
} satisfies PageConfig;

export async function action({ request, response }: PageActionContext<typeof config.action>) {
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
- `values` is echoed on failure only, never files, and omits names in `web.forms.redactValues` (default `password`, `password_confirmation`, `*token*`, `*secret*`).
- Same-origin `Origin`/`Referer` is always required (403 otherwise); no opt-out.
- Actions are never cached and always `private, no-store`; call `invalidatePageCache(tags)` to refresh other visitors' cached page.
- Redirect after success: a no-JS action that returns data re-POSTs on reload.
- `<Form>` defaults to `multipart/form-data`, so file inputs work; read them with `request.file(name)`.
- With `@mongez/react-form`, use `useSubmitAction` from `@warlock.js/web/form` and alias one of the two `Form`s.
