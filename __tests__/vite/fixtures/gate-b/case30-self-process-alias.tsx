// Case 30: `self.process` aliased to a variable, then `.env` read off the
// alias — must fail at the alias assignment.
const p = self.process;

export default function Case30Component() {
  return p.env.SECRET_KEY;
}
