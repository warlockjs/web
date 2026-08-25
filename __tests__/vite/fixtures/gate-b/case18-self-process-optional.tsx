// Case 18: optional chaining does not make self.process.env safe.
export default function Case18Component() {
  return self?.process?.env?.SECRET_KEY;
}
