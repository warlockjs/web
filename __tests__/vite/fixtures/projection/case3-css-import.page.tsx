// Case 3: a bare CSS import at the top — survives projection untouched.
import "./styles.css";

export const route = { path: "/blog" } as const;

export const loader = async () => {
  return { ok: true };
};

export default function BlogPage() {
  return <h1>Blog</h1>;
}
