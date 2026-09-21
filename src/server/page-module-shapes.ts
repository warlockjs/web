import type { NormalizedPageModule } from "./normalize-page-module";

/** A page declares either a bare path or a path plus an explicit route name. */
export type PageRouteExport = NonNullable<NormalizedPageModule["route"]>;

/** The page settings installers consume after config normalization. */
export type PageModuleShape = Pick<NormalizedPageModule, "route" | "cache">;

/** The layout pipeline view after config normalization. */
export type LayoutModuleShape = Pick<
  NormalizedPageModule,
  "register" | "prefix" | "default" | "middleware" | "loader" | "metadata" | "ErrorBoundary"
>;
