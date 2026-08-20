// Case 3: import.meta.env.PUBLIC_API_URL — a PUBLIC_-prefixed key — must
// succeed, this is exactly what the prefix exists for.
export default function Case3Component() {
  return import.meta.env.PUBLIC_API_URL;
}
