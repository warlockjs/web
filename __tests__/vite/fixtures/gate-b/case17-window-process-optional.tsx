// Case 17: optional chaining does not make window.process.env safe.
export default function Case17Component() {
  return window?.process?.env?.SECRET_KEY;
}
