/** Compile-time public type surface checks; these emit no runtime code. */
import type {
  AppLoader,
  AppLoaderContext,
  CrawlerDetectionOptions,
  LayoutLoader,
  LayoutLoaderContext,
  PageLoader,
  PageLoaderContext,
  WebConfigurations,
  WebStreamingConfigurations,
} from "./index";

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

export {};
