import { v } from "@warlock.js/seal";
import type { PageLoader, PageMetadata, PageProps } from "../../../src/index";
import "./types";

/**
 * The full-surface fixture page, in the v5/app contract shape
 * (product-details.page.tsx): declared route with `as const`, validation,
 * a loader that reads validated input, writes buffered response
 * headers/cookies, may short-circuit with `notFound()`, and metadata inferred
 * from the loader's data.
 */
export const route = {
  path: "/:id",
  name: "products.details",
} as const;

/**
 * Validated over params — the page's `{ schema, validating }` over params +
 * query. The 2-char floor gives the
 * specs a deterministic failure: `/products/x` → 422 before any loader runs.
 */
export const validation = {
  schema: v.object({
    id: v.string().minLength(2),
  }),
  validating: ["params"],
} as const;

export const loader = (async ({ request, response, shared }: any) => {
  const { id } = request.validated();

  if (id === "missing") {
    return response.notFound();
  }

  response.header("x-fixture-level", "page");
  response.header("cache-control", "private, max-age=60");
  response.cookie("last-product", id);

  return {
    product: { id, name: `Product ${id}`, locale: shared.locale },
  };
}) satisfies PageLoader<typeof validation, typeof route>;

export const metadata: PageMetadata<typeof loader> = ({ data }) => ({
  title: data.product.name,
});

export default function ProductDetailsPage({ data, shared }: PageProps<typeof loader>) {
  return (
    <article>
      <h1>{data.product.name}</h1>
      <p>{(shared as any)?.locale}</p>
    </article>
  );
}

export function ErrorBoundary({ error }: { error: Error & { digest?: string } }) {
  return (
    <main role="alert">
      <h1>Product page failed</h1>
      <p>{error?.message}</p>
    </main>
  );
}
