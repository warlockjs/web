// Case 1: server config + loader + a default export, sharing one import
// between `loader` and the component — the shared import must SURVIVE
// projection (still referenced by the component), the server-only exports
// must be GONE.
import { formatTitle } from "./helper";

export const config = {
  route: { path: "/blog" },
  middleware: [],
  validation: { schema: {} },
  metadata: { title: "Blog" },
} as const;

export const loader = async () => {
  return { title: formatTitle("Blog") };
};

export default function BlogPage({ data }: { data: { title: string } }) {
  return <h1>{formatTitle(data.title)}</h1>;
}
