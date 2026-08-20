// Case 8: import.meta.env.DEV — same Vite-injected built-in class as MODE,
// covered separately so the allowlist is checked per-key, not just for MODE.
export default function Case8Component() {
  return import.meta.env.DEV;
}
