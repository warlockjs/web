import {
  apiHref,
  href,
  navigateTo,
  runtimeRoute,
  type ApiRouteTarget,
  type LinkProps,
  type PageRouteTarget,
} from "@warlock.js/web";
import type { UseSubmitFormOptions } from "@warlock.js/web/form";

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
