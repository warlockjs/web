import { v } from "@warlock.js/seal";
import { describe, expectTypeOf, it } from "vitest";
import type { PageActionConfig, PageActionContext, PageConfig } from "./index";

/** The docs' own example (web/essentials/15-page-actions), verbatim in shape. */
const config = {
  route: { path: "/contact", name: "contact" },
  action: {
    validation: v.object({
      email: v.string().email().required(),
      message: v.string().required(),
    }),
  },
} satisfies PageConfig;

const namedConfig = {
  actions: {
    remove: { validation: v.object({ id: v.string().required() }) },
    archive: {},
  },
} satisfies PageConfig;

describe("page action public types", () => {
  it("types an optional site key as string", () => {
    function siteAware({ site }: PageActionContext) {
      expectTypeOf(site?.key).toEqualTypeOf<string | undefined>();
    }

    expectTypeOf(siteAware).toBeFunction();
  });

  it("accepts config.action and config.actions on PageConfig", () => {
    expectTypeOf(config.action).toMatchTypeOf<PageActionConfig>();
    expectTypeOf(namedConfig.actions.remove).toMatchTypeOf<PageActionConfig>();
  });

  // Type-only: these bodies are checked by tsc and never called.
  it("types request.validated() from the action's bare Seal validator", () => {
    function contact({ request }: PageActionContext<typeof config.action>) {
      const body = request.validated();

      expectTypeOf(body).not.toBeAny();
      expectTypeOf(body).toMatchTypeOf<{ email: string; message: string }>();
      expectTypeOf<{ email: string; message: string }>().toMatchTypeOf(body);
    }

    expectTypeOf(contact).toBeFunction();
  });

  it("types a named action from its own config.actions entry", () => {
    function remove({ request }: PageActionContext<typeof namedConfig.actions.remove>) {
      const body = request.validated();

      expectTypeOf(body).not.toBeAny();
      expectTypeOf(body).toMatchTypeOf<{ id: string }>();
      expectTypeOf<{ id: string }>().toMatchTypeOf(body);
    }

    expectTypeOf(remove).toBeFunction();
  });

  it("validates nothing when the action declares no validation", () => {
    function bare({ request }: PageActionContext) {
      expectTypeOf(request.validated()).toEqualTypeOf<Record<string, never>>();
    }

    function archive({ request }: PageActionContext<typeof namedConfig.actions.archive>) {
      expectTypeOf(request.validated()).toEqualTypeOf<Record<string, never>>();
    }

    expectTypeOf(bare).toBeFunction();
    expectTypeOf(archive).toBeFunction();
  });

  it("accepts a bare schema and a plain PageConfig annotation", () => {
    const commentSchema = v.object({ body: v.string().required() });

    function comment({ request }: PageActionContext<typeof commentSchema>) {
      const body = request.validated();

      expectTypeOf(body).not.toBeAny();
      expectTypeOf(body).toMatchTypeOf<{ body: string }>();
      expectTypeOf<{ body: string }>().toMatchTypeOf(body);
    }

    const annotated: PageConfig = {
      route: { path: "/comments", name: "comments" },
      actions: { comment: { validation: commentSchema } },
    };

    expectTypeOf(comment).toBeFunction();
    expectTypeOf(annotated).toEqualTypeOf<PageConfig>();
  });

  it("rejects an unknown key inside an action config", () => {
    // @ts-expect-error `schema` is the page validation shape, not an action's
    const _wrong = { action: { schema: v.object({}) } } satisfies PageConfig;
  });
});
