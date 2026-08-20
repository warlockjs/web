// Case 2: an import used ONLY inside `loader` — after projection that
// import must be GONE too (transitively orphaned).
import { fetchDraftStats } from "./server-only-helper";

export const loader = async () => {
  return { stats: await fetchDraftStats() };
};

export default function BlogPage() {
  return <h1>Blog</h1>;
}
