// Case 4: import.meta.env.DATABASE_URL — no PUBLIC_ prefix — must fail.
export default function Case4Component() {
  return import.meta.env.DATABASE_URL;
}
