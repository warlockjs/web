// Case 1: all 5 server exports + a default export, sharing one import
// between `loader` and the component — the shared import must SURVIVE
// projection (still referenced by the component), the 5 server exports
// must be GONE.
import { formatTitle } from "./helper";

export const route = { path: "/blog" } as const;

export const middleware = [];

export const validation = { schema: {} };

export const loader = async () => {
  return { title: formatTitle("Blog") };
};

export const metadata = { title: "Blog" };

export default function BlogPage({ data }: { data: { title: string } }) {
  return <h1>{formatTitle(data.title)}</h1>;
}
