import { describe, expect, it } from "vitest";
import {
  parseNamedApiRoutes,
  publishNamedApiRoutes,
  readNamedApiRoutes,
  resolveApiRoute,
} from "./named-api-routes";

describe("named API route registry", () => {
  it("accepts only name to path/method metadata and publishes it", () => {
    const routes = parseNamedApiRoutes({ "orders.get": { path: "/orders/:id", method: "GET" } });
    expect(routes).toEqual({ "orders.get": { path: "/orders/:id", method: "GET" } });
    publishNamedApiRoutes(routes);
    expect(readNamedApiRoutes()).toBe(routes);
  });

  it("refuses malformed route metadata without throwing", () => {
    expect(parseNamedApiRoutes({ orders: { path: "/orders" } })).toBeUndefined();
    expect(parseNamedApiRoutes([])).toBeUndefined();
  });

  it("resolves only own route names and preserves a literal prototype-shaped name", () => {
    publishNamedApiRoutes({});
    expect(() => resolveApiRoute("toString")).toThrow("unavailable");
    const routes = parseNamedApiRoutes(
      JSON.parse('{"__proto__":{"path":"/safe","method":"POST"}}'),
    );
    publishNamedApiRoutes(routes);
    expect(resolveApiRoute("__proto__")).toEqual({ path: "/safe", method: "POST" });
    expect(Object.isFrozen(resolveApiRoute("__proto__"))).toBe(true);
  });
});
