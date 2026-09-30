import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { serializeLoaderData } from "./serialize-loader-data";

class ResourceLike {
  public request: unknown;

  public constructor(private readonly value: unknown) {}

  public toJSON(): unknown {
    return { value: this.value, receivedRequest: this.request };
  }
}

describe("serializeLoaderData()", () => {
  it("serializes toJSON values, including nested object and array values, with the request", async () => {
    const request = { id: "request-1" };
    const value = {
      direct: new ResourceLike("direct"),
      nested: { resource: new ResourceLike("nested") },
      list: [new ResourceLike("array")],
    };

    const serialized = await serializeLoaderData(value, request as never);

    expect(parse(stringify(serialized))).toEqual({
      direct: { value: "direct", receivedRequest: request },
      nested: { resource: { value: "nested", receivedRequest: request } },
      list: [{ value: "array", receivedRequest: request }],
    });
    expect(value.direct).toBeInstanceOf(ResourceLike);
  });

  it("leaves devalue-native rich values unchanged", async () => {
    const date = new Date("2026-09-30T00:00:00.000Z");
    const map = new Map([["key", "value"]]);
    const set = new Set(["value"]);

    const serialized = await serializeLoaderData({ date, map, set }, {} as never);

    expect(serialized).toEqual({ date, map, set });
    expect(serialized).not.toBe({ date, map, set });
  });
});
