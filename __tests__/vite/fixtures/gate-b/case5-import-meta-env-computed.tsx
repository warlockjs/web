// Case 5: import.meta.env[someRuntimeVariable] — a computed key — must
// fail, the compiler must never guess whether a computed key is public.
export default function Case5Component(someRuntimeVariable: string) {
  return import.meta.env[someRuntimeVariable];
}
