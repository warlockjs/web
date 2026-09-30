import type { Serialized } from "@warlock.js/core";
import { parse, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { serializeLoaderData } from "./serialize-loader-data";

interface PostOutput {
  id: number;
  title: string;
  publishedAt: Date;
}

class PostResourceLike {
  public request: unknown;

  public constructor(private readonly id: number) {}

  public toJSON(): PostOutput {
    return { id: this.id, title: `Post ${this.id}`, publishedAt: new Date("2026-09-01T00:00:00.000Z") };
  }
}

/**
 * The type a page reads from its loader (`Serialized<Return, "devalue">`) must
 * describe what `serializeLoaderData` + devalue really produce. The literal
 * below is checked against the type at compile time (`satisfies`) and against
 * the runtime round trip at test time, so the two cannot drift apart silently.
 */
describe("Serialized<_, 'devalue'> parity with serializeLoaderData + devalue", () => {
  it("matches the value a page receives", async () => {
    const fixture = {
      post: new PostResourceLike(1),
      posts: [new PostResourceLike(2), new PostResourceLike(3)],
      at: new Date("2026-09-30T12:00:00.000Z"),
      counts: new Map([["views", 10]]),
      tags: new Set(["a", "b"]),
      nested: { flag: true, list: [1, 2, 3], missing: undefined as string | undefined, none: null },
      name: "Warlock",
    };

    const published = new Date("2026-09-01T00:00:00.000Z");

    const expected = {
      post: { id: 1, title: "Post 1", publishedAt: published },
      posts: [
        { id: 2, title: "Post 2", publishedAt: published },
        { id: 3, title: "Post 3", publishedAt: published },
      ],
      at: new Date("2026-09-30T12:00:00.000Z"),
      counts: new Map([["views", 10]]),
      tags: new Set(["a", "b"]),
      nested: { flag: true, list: [1, 2, 3], missing: undefined, none: null },
      name: "Warlock",
    } satisfies Serialized<typeof fixture, "devalue">;

    const serialized = await serializeLoaderData(fixture, {} as never);
    const received = parse(stringify(serialized));

    expect(received).toEqual(expected);
    expect(received.at).toBeInstanceOf(Date);
    expect(received.counts).toBeInstanceOf(Map);
    expect(received.tags).toBeInstanceOf(Set);
  });

  it("serializes what a nested promise settles to", async () => {
    const fixture = {
      post: Promise.resolve(new PostResourceLike(4)),
      list: [Promise.resolve(new PostResourceLike(5))],
      at: Promise.resolve(new Date("2026-09-30T12:00:00.000Z")),
    };

    const published = new Date("2026-09-01T00:00:00.000Z");

    const expected = {
      post: { id: 4, title: "Post 4", publishedAt: published },
      list: [{ id: 5, title: "Post 5", publishedAt: published }],
      at: new Date("2026-09-30T12:00:00.000Z"),
    } satisfies Serialized<typeof fixture, "devalue">;

    // Before settled values were serialized, a class instance reached devalue
    // here and `stringify` threw.
    const received = parse(stringify(await serializeLoaderData(fixture, {} as never)));

    expect(received).toEqual(expected);
  });

  it("leaves plain JSON-ish data unchanged", async () => {
    const fixture = { id: 7, tags: ["x"], owner: { name: "Hasan", active: true }, note: null };

    const expected = {
      id: 7,
      tags: ["x"],
      owner: { name: "Hasan", active: true },
      note: null,
    } satisfies Serialized<typeof fixture, "devalue">;

    const received = parse(stringify(await serializeLoaderData(fixture, {} as never)));

    expect(received).toEqual(expected);
  });
});
