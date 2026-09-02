// Case 26: `process.env[someRuntimeVariable]` — a computed, non-literal key
// read off `process.env`. Must fail even though the key COULD hold a
// "PUBLIC_"-prefixed name at runtime — the compiler cannot guess, and
// process.env is forbidden client-side regardless of key anyway.
declare const someRuntimeVariable: string;

export default function Case26Component() {
  return process.env[someRuntimeVariable];
}
