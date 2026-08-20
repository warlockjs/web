// Case 2: a page importing a sibling .server.ts file DIRECTLY — must fail.
import { loadBlogPosts } from "./case2.server";

export const route = { path: "/blog" };

export default function BlogPage() {
  return loadBlogPosts();
}
