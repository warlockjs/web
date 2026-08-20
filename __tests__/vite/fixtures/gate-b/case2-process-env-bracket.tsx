// Case 2: process.env["SECRET_KEY"] read via static bracket notation — must
// fail the same as dot notation; bracket syntax is not a bypass.
export default function Case2Component() {
  return process.env["SECRET_KEY"];
}
