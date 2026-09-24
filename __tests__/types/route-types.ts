import {
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
  }

  interface ApiRouteRegistry {
    "posts.update": { path: "/api/posts/:id"; params: { id: number }; method: "PATCH" };
    fallback: { path: "/api/*"; params: { "*": string }; method: "ALL" };
  }
}

const pageTarget: PageRouteTarget = { name: "posts.show", params: { slug: "typed" } };
const optionalPageTarget: PageRouteTarget = { name: "search" };
const dynamicPageTarget: PageRouteTarget = { name: runtimeRoute("tenant.page") };
const apiTarget: ApiRouteTarget = { name: "posts.update", method: "PATCH", params: { id: 1 } };
const namedHref = href("posts.show", { slug: "typed" });
const namedNavigation = navigateTo({ name: "posts.show", params: { slug: "typed" } });
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
  namedNavigation,
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

void [missingPageParams, wrongApiMethod, allApiTarget, wrongSubmit, missingLinkParams];
