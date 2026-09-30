import { expectTypeOf } from "vitest";
import {
  useUser,
  type GuardedPageRouteName,
  type PageConfig,
  type PageLoader,
  type PageLoaderContext,
  type PageProps,
  type SessionModel,
  type SessionUser,
} from "@warlock.js/web";
import { requireUser } from "@warlock.js/web/session";

/**
 * A page guarded by `requireUser()` is typed as signed-in: its loader's `request.locals.user` and
 * `session` are non-null, and `useUser("<its name>")` is non-null. The generated registry marks
 * such a page `guard: "user"`; everything here is what the generator's output does to the types.
 */

interface AccountUser {
  id: number;
  name: string;
}

interface AccountModel {
  id: number;
  email: string;
  isAdmin: boolean;
}

declare module "@warlock.js/web" {
  interface SessionRegistry {
    user: AccountUser;
    model: AccountModel;
  }

  interface PageRouteRegistry {
    "account.show": { path: "/account"; params: {}; actions: "save"; guard: "user" };
    "account.orders": { path: "/account/orders"; params: {}; guard: "user" };
    about: { path: "/about"; params: {} };
  }
}

// The registry decides which names are guarded.
expectTypeOf<GuardedPageRouteName>().toEqualTypeOf<"account.show" | "account.orders">();

// The developer-facing shape: a guarded page file.
const route = { path: "/account", name: "account.show" } as const;

export const config = {
  route,
  middleware: [requireUser()],
} satisfies PageConfig<typeof loader>;

export const loader = async ({ request, session }: PageLoaderContext<undefined, typeof route>) => {
  // `RequestUser & AccountModel` when auth augments `RequestLocals`: the model, never undefined.
  expectTypeOf(request.locals.user).toExtend<AccountModel>();
  expectTypeOf(request.locals.user).not.toBeNullable();
  expectTypeOf(session.user).toEqualTypeOf<AccountUser>();
  expectTypeOf(session.model).toEqualTypeOf<AccountModel>();

  return { name: session.user.name, email: request.locals.user.email };
};

export default function AccountPage({ data }: PageProps<typeof loader>) {
  const user = useUser("account.show");

  expectTypeOf(user).toEqualTypeOf<AccountUser>();

  return `${data.name} ${user.name}`;
}

// The name is inferred from `typeof config.route`, too.
const inferred = {
  route: { path: "/account/orders", name: "account.orders" },
  middleware: [requireUser()],
} as const satisfies PageConfig;

export const inferredLoader = async (
  context: PageLoaderContext<undefined, typeof inferred.route>,
) => {
  expectTypeOf(context.session.user).toEqualTypeOf<AccountUser>();
  expectTypeOf(context.request.locals.user).toExtend<AccountModel>();
  expectTypeOf(context.request.locals.user).not.toBeNullable();
};

// An explicit name works for a page whose name is filesystem-derived (no `route` export).
export const explicitName = async (
  context: PageLoaderContext<undefined, undefined, "account.show">,
) => {
  expectTypeOf(context.session.model).toEqualTypeOf<AccountModel>();
};

// `PageLoader` narrows the same way.
export const typedLoader: PageLoader<undefined, typeof route> = ({ session }) => {
  expectTypeOf(session.user).toEqualTypeOf<AccountUser>();
};

// An unguarded page is unchanged: optional locals user, nullable session.
const aboutRoute = { path: "/about", name: "about" } as const;

export const aboutLoader = async (context: PageLoaderContext<undefined, typeof aboutRoute>) => {
  expectTypeOf(context.session).toEqualTypeOf<
    { user: AccountUser | null; model: AccountModel | null } | undefined
  >();

  expectTypeOf(context.request.locals.user).toBeNullable();

  // @ts-expect-error `session` is optional on an unguarded page.
  void context.session.user;
};

// No route at all, a bare path string, and an undeclared name are unguarded.
expectTypeOf<PageLoaderContext["session"]>().toEqualTypeOf<
  { user: AccountUser | null; model: AccountModel | null } | undefined
>();
expectTypeOf<PageLoaderContext<undefined, "/account">["session"]>().toEqualTypeOf<
  { user: AccountUser | null; model: AccountModel | null } | undefined
>();
expectTypeOf<PageLoaderContext<undefined, undefined, "account.unknown">["session"]>().toEqualTypeOf<
  { user: AccountUser | null; model: AccountModel | null } | undefined
>();
// A widened `string` name or a mixed union is not provably guarded.
expectTypeOf<PageLoaderContext<undefined, undefined, string>["session"]>().toEqualTypeOf<
  { user: AccountUser | null; model: AccountModel | null } | undefined
>();
expectTypeOf<PageLoaderContext<undefined, undefined, "account.show" | "about">["session"]>().toEqualTypeOf<
  { user: AccountUser | null; model: AccountModel | null } | undefined
>();

// A guarded context keeps everything else a page loader receives.
expectTypeOf<PageLoaderContext<undefined, typeof route>["route"]>().toEqualTypeOf<
  PageLoaderContext["route"]
>();
expectTypeOf<PageLoaderContext<undefined, typeof route>["response"]>().toEqualTypeOf<
  PageLoaderContext["response"]
>();

// `useUser`: the plain form is still nullable; a guarded name is not; an unguarded name is refused.
expectTypeOf(useUser()).toEqualTypeOf<AccountUser | null>();
expectTypeOf(useUser("account.orders")).toEqualTypeOf<AccountUser>();
// @ts-expect-error `about` is not a guarded page, so the non-null overload refuses it.
useUser("about");
// @ts-expect-error a name nobody registered is refused as well.
useUser("nope");

expectTypeOf<SessionUser>().toEqualTypeOf<AccountUser>();
expectTypeOf<SessionModel>().toEqualTypeOf<AccountModel>();
