import type {
  LayoutConfig,
  PageConfig,
  PageConfigValidation,
  PageErrorBoundaryProps,
  RootConfig,
} from "@warlock.js/web";
import type { BaseValidator } from "@warlock.js/seal";

const validator = {} as BaseValidator;
const loader = async () => ({ product: { name: "Warlock", price: 12 } });

const pageConfig = {
  route: { path: "/products/:id", name: "products.detail" },
  cache: { public: true, maxAge: 60 },
  validation: { query: validator },
  metadata: ({ data }) => ({ title: `${data.product.name} ${data.product.price}` }),
} satisfies PageConfig<typeof loader>;

pageConfig.route?.path;

const schemaValidation: PageConfigValidation = { schema: validator, validating: ["body"] };
const paramsValidation: PageConfigValidation = { params: validator, query: validator };
void schemaValidation;
void paramsValidation;

const layoutConfig = {
  prefix: "/products",
  middleware: [],
  metadata: { robots: "index,follow" },
  sitemap: false,
} satisfies LayoutConfig;

const rootConfig = { middleware: [] } satisfies RootConfig;
const boundaryProps: PageErrorBoundaryProps = { error: new Error("expected") };
void layoutConfig;
void rootConfig;
void boundaryProps;

const invalidUnknownKey = {
  // @ts-expect-error PageConfig has no index signature for unknown policy keys.
  unknownPolicy: true,
} satisfies PageConfig;
void invalidUnknownKey;

const invalidRouteKey = {
  route: {
    path: "/products",
    // @ts-expect-error Cache policy belongs beside route, never inside it.
    cache: { public: true, maxAge: 60 },
  },
} satisfies PageConfig;
void invalidRouteKey;

const invalidEmptyValidation = {
  // @ts-expect-error A validation config needs schema, params, or query.
  validation: {},
} satisfies PageConfig;
void invalidEmptyValidation;

const invalidMixedValidation = {
  validation: {
    schema: validator,
    // @ts-expect-error Schema validation cannot be mixed with params validation.
    params: validator,
  },
} satisfies PageConfig;
void invalidMixedValidation;

const invalidLayoutRoute = {
  // @ts-expect-error Layouts cannot own page routes.
  route: "/products",
} satisfies LayoutConfig;
void invalidLayoutRoute;

const invalidLayoutCache = {
  // @ts-expect-error Layouts cannot own page cache policy.
  cache: { public: true, maxAge: 60 },
} satisfies LayoutConfig;
void invalidLayoutCache;

const invalidLayoutSupplier = {
  // @ts-expect-error Layout sitemaps cannot be dynamic suppliers.
  sitemap: () => [],
} satisfies LayoutConfig;
void invalidLayoutSupplier;

const invalidRoot = {
  // @ts-expect-error Root config has no metadata policy.
  metadata: { robots: "noindex" },
} satisfies RootConfig;
void invalidRoot;

const invalidBoundary = {
  // @ts-expect-error ErrorBoundary remains a named module export.
  ErrorBoundary: () => null,
} satisfies PageConfig;
void invalidBoundary;

const invalidMetadataValue = {
  metadata: {
    // @ts-expect-error Metadata title must be a string.
    title: 42,
  },
} satisfies PageConfig;
void invalidMetadataValue;

const invalidMetadataData = {
  metadata: ({ data }) => ({
    // @ts-expect-error Loader data preserves its concrete shape.
    title: data.product.missing,
  }),
} satisfies PageConfig<typeof loader>;
void invalidMetadataData;
