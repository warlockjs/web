import { describe, expect, it } from "vitest";
import { ConflictingRouteTypeNameError, generateRouteTypes } from "./generate-route-types";

describe("generateRouteTypes", () => {
  it("sorts maps and represents optional, wildcard, methods, and escaped names", () => {
    const source = generateRouteTypes({
      pages: [
        { name: "admin.users.show", path: "/admin/users/:id", method: "GET" },
        { name: 'z"page', path: "/files/*", method: "GET" },
        { name: "posts.show", path: "/posts/:id/:slug?", method: "GET" },
      ],
      apiRoutes: [{ name: "posts.update", path: "/api/posts/:id", method: "PATCH" }],
    });

    expect(source).toContain(
      '"posts.show": { path: "/posts/:id/:slug?"; params: { "id": RouteParamValue; "slug"?: RouteParamValue } };',
    );
    expect(source).toContain('"z\\"page": { path: "/files/*"; params: { "*": RouteParamValue } };');
    expect(source).toContain(
      '"posts.update": { path: "/api/posts/:id"; params: { "id": RouteParamValue }; method: "PATCH" };',
    );
    expect(source).toContain(
      '"admin.users.show": { path: "/admin/users/:id"; params: { "id": RouteParamValue } };',
    );
    expect(source.indexOf('"posts.show"')).toBeLessThan(source.indexOf('"z\\"page"'));
  });

  it("always emits both empty registries so a later atomic writer can delete stale entries", () => {
    const populated = generateRouteTypes({
      pages: [{ name: "posts.show", path: "/posts/:id", method: "GET" }],
      apiRoutes: [],
    });
    const source = generateRouteTypes({ pages: [], apiRoutes: [] });

    expect(populated).toContain('"posts.show"');
    expect(source).not.toContain('"posts.show"');
    expect(source).toContain("interface PageRouteRegistry {");
    expect(source).toContain("interface ApiRouteRegistry {");
  });

  it("canonicalizes API method spelling before it reaches generated declarations", () => {
    const source = generateRouteTypes({
      pages: [],
      apiRoutes: [{ name: "posts.create", path: "/posts", method: "post" }],
    });

    expect(source).toContain('"posts.create": { path: "/posts"; params: {}; method: "POST" };');
    expect(source).not.toContain('method: "post"');
  });

  it("refuses conflicting duplicate names instead of choosing one", () => {
    expect(() =>
      generateRouteTypes({
        pages: [
          { name: "posts.show", path: "/posts/:id", method: "GET" },
          { name: "posts.show", path: "/articles/:id", method: "GET" },
        ],
        apiRoutes: [],
      }),
    ).toThrow(ConflictingRouteTypeNameError);
  });
});

describe("generateRouteTypes page actions", () => {
  it("emits sorted action names on the page entry and nothing when there are none", () => {
    const source = generateRouteTypes({
      pages: [
        { name: "admin.posts.edit", path: "/admin/posts/:id", method: "GET", actions: ["save", "remove"] },
        { name: "home", path: "/", method: "GET" },
      ],
      apiRoutes: [],
    });

    expect(source).toContain(
      '"admin.posts.edit": { path: "/admin/posts/:id"; params: { "id": RouteParamValue }; actions: "remove" | "save" };',
    );
    expect(source).toContain('"home": { path: "/"; params: {} };');
  });
});

describe("generateRouteTypes typed responses", () => {
  const login =
    '{ "user": import("@warlock.js/core").ResourceOutput<typeof import("../../src/app/users/resources/user.resource")["userResource"]>; "token": import("@warlock.js/core").CastOutput<"string"> }';
  const failure = '{ "error": import("@warlock.js/core").CastOutput<"string"> }';

  it("emits declared response bodies on the API entry with ascending numeric status keys", () => {
    const source = generateRouteTypes({
      pages: [],
      apiRoutes: [
        { name: "auth.login", path: "/login", method: "POST", response: { 400: failure, 200: login } },
      ],
    });

    expect(source).toContain(
      `    "auth.login": { path: "/login"; params: {}; method: "POST"; response: { 200: ${login}; 400: ${failure} } };`,
    );
  });

  it("emits nothing extra for routes without a response, and ignores response on pages", () => {
    const plain = { name: "posts.list", path: "/posts", method: "GET" };
    const without = generateRouteTypes({ pages: [plain], apiRoutes: [plain] });
    const empty = generateRouteTypes({
      pages: [{ ...plain, response: { 200: login } }],
      apiRoutes: [{ ...plain, response: {} }],
    });

    expect(without).not.toContain("response");
    expect(empty).toBe(without);
  });
});
