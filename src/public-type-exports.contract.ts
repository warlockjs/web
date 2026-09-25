/** Compile-time public type surface checks; these emit no runtime code. */
import type {
  ActionResponse,
  ActionState,
  PageActionContext,
  PageActionNames,
  PageRedirectSignal,
  PageSession,
  AppLoader,
  AppLoaderContext,
  CrawlerDetectionOptions,
  LayoutLoader,
  LayoutLoaderContext,
  PageLoader,
  PageLoaderContext,
  SessionResolver,
  WebConfigurations,
  WebStreamingConfigurations,
} from "./index";
import type { RequireUserContext } from "./session/require-user";

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type _PageLoaderContextMatchesLoader = Assert<
  Equal<PageLoaderContext<undefined, undefined>, Parameters<PageLoader>[0]>
>;
type _LayoutLoaderContextMatchesLoader = Assert<
  Equal<LayoutLoaderContext, Parameters<LayoutLoader>[0]>
>;
type _AppLoaderContextMatchesLoader = Assert<Equal<AppLoaderContext, Parameters<AppLoader>[0]>>;
type _StreamingConfigHasCrawlerOption = Assert<
  WebStreamingConfigurations["crawlers"] extends false | CrawlerDetectionOptions | undefined
    ? true
    : false
>;
type _WebConfigExposesStreaming = Assert<
  WebConfigurations["streaming"] extends WebStreamingConfigurations | undefined ? true : false
>;
type _WebConfigExposesSession = Assert<
  WebConfigurations["session"] extends SessionResolver | undefined ? true : false
>;
// A `project` result without `id` must fail to compile.
// @ts-expect-error a resolver whose user has no `id` is rejected
type _ResolverWithoutId = SessionResolver<unknown, { name: string }>;

export {};

type _PageSessionCarriesUserAndModel = Assert<
  PageSession extends { user: unknown; model: unknown } ? true : false
>;
type _PageRedirectSignalIsAnError = Assert<PageRedirectSignal extends Error ? true : false>;

type _PageActionContextCarriesActionResponse = Assert<
  Equal<PageActionContext["response"], ActionResponse>
>;
type _ActionStateIsExported = Assert<ActionState extends { ok: boolean } ? true : false>;
type _PageActionNamesFallsBackToString = Assert<
  Equal<PageActionNames<"unknown.route">, string>
>;

type _PageLoaderContextExposesSession = Assert<
  Equal<PageLoaderContext<undefined, undefined>["session"], PageSession | undefined>
>;
type _LayoutLoaderContextExposesSession = Assert<
  Equal<LayoutLoaderContext["session"], PageSession | undefined>
>;
type _AppLoaderContextExposesSession = Assert<
  Equal<AppLoaderContext["session"], PageSession | undefined>
>;
type _PageActionContextExposesSession = Assert<
  Equal<PageActionContext["session"], PageSession | undefined>
>;
// requireUser(ctx) must accept the public loader context users actually hold.
type _RequireUserAcceptsPageLoaderContext = Assert<
  PageLoaderContext<undefined, undefined> extends RequireUserContext ? true : false
>;
