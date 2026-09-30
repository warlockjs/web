---
name: submit-a-form
description: "Submit a @mongez/react-form through a named Core API route or explicit path with useSubmitForm from @warlock.js/web/form. Types `data` and `onSuccess` from the route's `responseSchema`. Triggers: useSubmitForm, FormData API submit, beforeSubmit, mapFieldErrors, formErrors, named API route, ApiResponse, ApiSuccessResponse, typed response."
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

## Validate in the browser with the same schema

`@mongez/react-form` accepts a Standard Schema through its `schema` prop, so a
browser-safe Seal schema can be shared with the API route's server validation:

```tsx
import { Form } from "@mongez/react-form";
import { useSubmitForm } from "@warlock.js/web/form";
import { contactSchema } from "./contact.schema";

export default function ContactForm() {
  const submit = useSubmitForm({ path: "/api/contact" });

  return (
    <Form schema={contactSchema} onSubmit={submit.submit}>
      {/* Registered controls use the schema's field names. */}
    </Form>
  );
}
```

Client validation is feedback, not authorization: the API must validate the
same schema itself, because a browser can be bypassed. For a page action, put
the schema in `config.action.validation` and submit with `useSubmitAction`, not
`useSubmitForm`. Do not share database uniqueness checks or other server-only
rules with the browser; keep those server-side or split the schema.

## Typed responses from `responseSchema`

When the API handler declares `responseSchema` (see core's `create-controller`), the generated `ApiRouteRegistry` entry carries a `response` map and `useSubmitForm({ route })` types `data`, `response` and `onSuccess` from the route's declared 2xx body. No generic argument and no cast.

```ts title="src/app/auth/controllers/login.controller.ts (core)"
loginController.responseSchema = {
  200: { body: { user: UserResource, token: "string" } },
  400: { body: { error: "string" } },
};
```

```tsx title="src/web/login.page.tsx"
import { Form } from "@mongez/react-form";
import { useSubmitForm } from "@warlock.js/web/form";

export default function Login() {
  const login = useSubmitForm({
    route: "auth.login",
    onSuccess: async ({ data }) => {
      if (data) {
        console.log(data.user.name, data.token); // typed from the 200 body
      }
    },
  });

  return <Form onSubmit={login.submit}>{/* fields */}</Form>;
}
```

`login.data` is the same body type (or `null` until a success). The body is the whole declared 2xx body: with several 2xx statuses it is their union.

Read a declared body anywhere with the public types from `@warlock.js/web`:

| Type                            | Is                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `ApiResponse<Name, Status = 200>` | The declared body for that status, or `unknown` when the route or status is undeclared (never `any`). |
| `ApiResponses<Name>`            | The whole status-to-body map (empty for an undeclared or `runtimeRoute` name).   |
| `ApiSuccessResponse<Name>`      | The union of the declared 2xx bodies, or `unknown` when there is none.            |

```ts
import type { ApiResponse } from "@warlock.js/web";

type LoginError = ApiResponse<"auth.login", 400>; // { error: string }
```

- Without `responseSchema` the body stays `unknown`, and an app with no `responseSchema` anywhere generates a byte-identical registry file.
- A path target (`{ path }`) and an explicit `useSubmitForm<Schema, Data>` call are unchanged: you supply `Data` yourself.
- The generated entry maps each resource back to its `*.resource.ts(x)` export; a resource defined elsewhere is typed `unknown` and core warns with the route and field.

Named route metadata contains the name, path and method, and a `response` map when the handler declares `responseSchema`. A route declared with method `all` cannot select a browser verb: use a direct `path` and explicit `method`.

Generated API declarations live in `ApiRouteRegistry`, separately from page
names. They preserve canonical method case (for example `POST`) and parameter
optionality; an advanced path shape that cannot be represented precisely uses
broad params rather than a guessed type. `runtimeRoute(name)` is the explicit
escape for a genuinely dynamic API name. There is no legacy map fallback.

Core obtains these declarations in a fresh registration-only child before a
Web build contribution: it does not register, boot, or start connectors.
Application module top-level imports still execute in that child, so keep such
modules free of unwanted side effects. Development writes the same declaration
after successful registration/reload. Include `.warlock/typings/*.d.ts` in
your TypeScript project; a generated file is replaced atomically and is cleared
only when its Warlock ownership header proves it is framework-owned.
