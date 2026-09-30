import { beforeEach, describe, expect, it } from "vitest";
import { apiHref } from "./api-href";
import { publishNamedApiRoutes } from "./named-api-routes";

beforeEach(() => publishNamedApiRoutes(undefined));

describe("apiHref", () => {
  it("interpolates published API route params and shares href's query grammar", () => {
    publishNamedApiRoutes({ "orders.show": { path: "/api/orders/:id", method: "GET" } });

    expect(apiHref("orders.show", { params: { id: 7 }, query: { tags: ["new", "paid"] } })).toBe(
      "/api/orders/7?tags%5B%5D=new&tags%5B%5D=paid",
    );
  });

  it("fails for a missing API path parameter", () => {
    publishNamedApiRoutes({ "orders.show": { path: "/api/orders/:id", method: "GET" } });

    expect(() => apiHref("orders.show", {})).toThrow('missing path parameter "id"');
  });
});
