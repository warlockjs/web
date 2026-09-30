import { expectTypeOf } from "vitest";
import {
  apiHref,
  href,
  navigateTo,
  runtimeRoute,
  type ApiResponse,
  type ApiResponses,
  type ApiRouteTarget,
  type LinkProps,
  type PageRouteTarget,
} from "@warlock.js/web";
import { useSubmitForm, type UseSubmitFormOptions } from "@warlock.js/web/form";

declare module "@warlock.js/web" {
  interface PageRouteRegistry {
    "posts.show": { path: "/posts/:slug"; params: { slug: string } };
    search: { path: "/search/:term?"; params: { term?: string } };
    "search.fields": { path: "/search/:params/:query"; params: { params: string; query: string } };
  }

  interface ApiRouteRegistry {
    "posts.update": { path: "/api/posts/:id"; params: { id: number }; method: "PATCH" };
    "posts.list": { path: "/api/posts"; params: {}; method: "GET" };
    fallback: { path: "/api/*"; params: { "*": string }; method: "ALL" };
    "auth.login": {
      path: "/api/login";
      params: {};
      method: "POST";
      response: {
        200: { user: { id: number; name: string }; token: string; expiresAt?: number };
        400: { error: string };
      };
    };
  }
}

const pageTarget: PageRouteTarget = { name: "posts.show", params: { slug: "typed" } };
const optionalPageTarget: PageRouteTarget = { name: "search" };
const dynamicPageTarget: PageRouteTarget = { name: runtimeRoute("tenant.page") };
const apiTarget: ApiRouteTarget = { name: "posts.update", method: "PATCH", params: { id: 1 } };
const namedHref = href("posts.show", { slug: "typed" });
const namedObjectHref = href("posts.show", {
  params: { slug: "typed" },
  query: { tab: "details" },
});
const positionalReservedParamsHref = href("search.fields", { params: "one", query: "two" });
const namedNavigation = navigateTo({
  name: "posts.show",
  params: { slug: "typed" },
  query: { tab: "details" },
});
const namedApiHref = apiHref("posts.update", { params: { id: 1 }, query: { include: "author" } });
const paramlessApiHref = apiHref("posts.list");
const namedSubmit: UseSubmitFormOptions = {
  route: "posts.update",
  method: "PATCH",
  params: { id: 1 },
};
const namedLink: LinkProps = { to: "posts.show", params: { slug: "typed" } };
const literalLink: LinkProps = { href: "/pricing" };

void [
  pageTarget,
  optionalPageTarget,
  dynamicPageTarget,
  apiTarget,
  namedHref,
  namedObjectHref,
  positionalReservedParamsHref,
  namedNavigation,
  namedApiHref,
  paramlessApiHref,
  namedSubmit,
  namedLink,
  literalLink,
];

// @ts-expect-error Generated required params stay required.
const missingPageParams: PageRouteTarget = { name: "posts.show" };
// @ts-expect-error Generated API methods stay correlated to their route name.
const wrongApiMethod: ApiRouteTarget = { name: "posts.update", method: "POST", params: { id: 1 } };
const allApiTarget: ApiRouteTarget = {
  // @ts-expect-error `ALL` cannot become a browser submit target.
  name: "fallback",
  method: "ALL",
  params: { "*": "anything" },
};
// @ts-expect-error Known API routes cannot override their generated method.
const wrongSubmit: UseSubmitFormOptions = {
  route: "posts.update",
  method: "POST",
  params: { id: 1 },
};
// @ts-expect-error Known link params remain required for their route name.
const missingLinkParams: LinkProps = { to: "posts.show" };
// @ts-expect-error Generated page URLs require their path params in object form.
const missingHrefParams = href("posts.show", { query: { tab: "details" } });
// @ts-expect-error Generated API names reject typos.
const wrongApiHrefName = apiHref("posts.updtae", { params: { id: 1 } });
// @ts-expect-error Generated API URLs require their path params.
const missingApiHrefParams = apiHref("posts.update", {});
// @ts-expect-error Options stay required when the route has path params.
const omittedApiHrefOptions = apiHref("posts.update");

void [
  missingPageParams,
  wrongApiMethod,
  allApiTarget,
  wrongSubmit,
  missingLinkParams,
  missingHrefParams,
  wrongApiHrefName,
  missingApiHrefParams,
  omittedApiHrefOptions,
];

// Typed API responses: a declared body is exact, everything else is `unknown`, never `any`.
type LoginOk = { user: { id: number; name: string }; token: string; expiresAt?: number };

expectTypeOf<ApiResponse<"auth.login">>().toEqualTypeOf<LoginOk>();
expectTypeOf<ApiResponse<"auth.login", 200>>().toEqualTypeOf<LoginOk>();
expectTypeOf<ApiResponse<"auth.login", 400>>().toEqualTypeOf<{ error: string }>();
expectTypeOf<ApiResponses<"auth.login">>().toHaveProperty(400);
// An undeclared status, an undeclared route and a dynamic route are all `unknown`.
expectTypeOf<ApiResponse<"auth.login", 500>>().toBeUnknown();
expectTypeOf<ApiResponse<"posts.list">>().toBeUnknown();
expectTypeOf<ApiResponse<ReturnType<typeof runtimeRoute>>>().toBeUnknown();

declare const login: ApiResponse<"auth.login">;
void login.user.name;
// @ts-expect-error A field the route does not declare fails to compile.
void login.nonexistent;
declare const unknownBody: ApiResponse<"posts.list">;
// @ts-expect-error An undeclared route body is `unknown`, so property access is refused.
void unknownBody.anything;

// Named form targets resolve their success body from the route's declared response.
const loginForm = useSubmitForm({
  route: "auth.login",
  onSuccess: (response) => {
    expectTypeOf(response.data).toEqualTypeOf<LoginOk | null>();
  },
});
expectTypeOf(loginForm.data).toEqualTypeOf<LoginOk | null>();
const listForm = useSubmitForm({ route: "posts.list" });
expectTypeOf(listForm.data).toEqualTypeOf<unknown>();
// An explicit response type still wins for callers that provide one.
const explicitForm = useSubmitForm<undefined, { ok: true }>({ path: "/api/x" });
expectTypeOf(explicitForm.data).toEqualTypeOf<{ ok: true } | null>();
