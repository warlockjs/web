---
name: submit-a-form
description: "Submit a @mongez/react-form through a named Core API route or explicit path with useSubmitForm from @warlock.js/web/form. Triggers: useSubmitForm, FormData API submit, beforeSubmit, mapFieldErrors, formErrors, named API route."
---

# Submit a form

Import the optional form integration from `@warlock.js/web/form`, not the Web root barrel. It requires peer packages `@mongez/http:^3.5.0` and `@mongez/react-form:^4.0.0`.

```tsx
import { Form } from "@mongez/react-form";
import { useSubmitForm } from "@warlock.js/web/form";

export default function Login() {
  const login = useSubmitForm({
    route: "auth.login",
    beforeSubmit: ({ values }) => Boolean(values.email),
    onSuccess: async result => console.log(result.data),
  });

  return <Form onSubmit={login.submit}>{/* fields */}</Form>;
}
```

Provide exactly one target. `route` resolves the server-registered API name and its declared method; `path` is direct and defaults to `POST` unless `method` is supplied. Supply `params` for `:segments` and `query` for URL parameters. GET and HEAD serialize form values into the query; other methods send the Form's native `FormData`.

The default client is the configured `@mongez/http` singleton, so its base URL and interceptors remain active. Pass `client` only to use another configured `Http` instance.

`response`, `data`, and `error` start as `null`; `onSuccess`, `onError`, and `onComplete` receive the full `HttpResult`. Duplicate calls share the active submission. `cancel()` cancels it, and `reset()` clears hook state and errors assigned by the hook.

Validation mapping is on by default. Known server field errors are assigned to controls; unknown fields and general messages go to `formErrors`. Set `mapFieldErrors: false` to leave controls untouched or provide a mapper returning `{ [field]: message }`.

Named route metadata contains only name, path, and method. A route declared with method `all` cannot select a browser verb: use a direct `path` and explicit `method`.
