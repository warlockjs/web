// Case 23: destructuring a key straight off `process.env` — the base is a
// direct child of the VariableDeclarator, never wrapped in one more `.KEY`
// MemberExpression, so it is a bare whole-object reference. Must fail.
const { APP_SECRET } = process.env;

export default function Case23Component() {
  return APP_SECRET;
}
