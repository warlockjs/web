// Case 19: optional chaining around a bracketed globalThis process read must fail.
export default function Case19Component() {
  return globalThis?.["process"]?.env?.SECRET_KEY;
}
