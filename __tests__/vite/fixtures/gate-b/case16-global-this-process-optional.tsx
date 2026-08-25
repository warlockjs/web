// Case 16: optional chaining does not make globalThis.process.env safe.
export default function Case16Component() {
  return globalThis?.process?.env?.SECRET_KEY;
}
