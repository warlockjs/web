import { expectTypeOf } from "vitest";
import { useUser, type PageLoaderContext } from "@warlock.js/web";

/**
 * An app that registers no `SessionRegistry.model`: `SessionModel` is `unknown`, so a guarded page's
 * `request.locals.user` falls back to the app's own `RequestLocals["user"]` augmentation (auth's
 * `RequestUser`, read off core's interface; web never imports auth), and `session.model` is `{}`.
 */

declare module "@warlock.js/auth" {
  interface RequestUser {
    email: string;
  }
}

declare module "@warlock.js/web" {
  interface PageRouteRegistry {
    "account.show": { path: "/account"; params: {}; guard: "user" };
    about: { path: "/about"; params: {} };
  }
}

export const loader = async ({
  request,
  session,
}: PageLoaderContext<undefined, undefined, "account.show">) => {
  expectTypeOf(request.locals.user.email).toEqualTypeOf<string>();
  expectTypeOf(request.locals.user).not.toBeNullable();
  expectTypeOf(session.user).toEqualTypeOf<{ id: string | number }>();
  expectTypeOf(session.model).not.toBeNullable();
};

export const aboutLoader = async (context: PageLoaderContext<undefined, undefined, "about">) => {
  expectTypeOf(context.session).toBeNullable();
  expectTypeOf(context.request.locals.user).toBeNullable();
};

expectTypeOf(useUser("account.show")).toEqualTypeOf<{ id: string | number }>();
expectTypeOf(useUser()).toEqualTypeOf<{ id: string | number } | null>();
