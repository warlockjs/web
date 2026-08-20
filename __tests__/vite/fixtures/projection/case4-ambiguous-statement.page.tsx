// Case 4: a top-level statement outside any export — attribution-ambiguous,
// the build must FAIL naming the file, the statement, and the fix.
console.log("boot");

export const route = { path: "/blog" } as const;

export default function BlogPage() {
  return <h1>Blog</h1>;
}
