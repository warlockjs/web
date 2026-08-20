// Case 7: import.meta.env.MODE — a Vite-injected built-in, not a PUBLIC_
// app secret — must succeed even though it doesn't start with "PUBLIC_".
export default function Case7Component() {
  return import.meta.env.MODE;
}
