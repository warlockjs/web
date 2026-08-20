// Case 5: `loader` written as an async function DECLARATION, not an
// arrow-const — still stripped correctly.
export async function loader() {
  return { ok: true };
}

export default function BlogPage() {
  return <h1>Blog</h1>;
}
