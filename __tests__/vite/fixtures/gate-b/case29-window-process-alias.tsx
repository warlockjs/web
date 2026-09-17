// Case 29: `window.process` aliased to a variable, then `.env` read off the
// alias — must fail at the alias assignment, not only a direct
// `window.process.env` read.
const p = window.process;

export default function Case29Component() {
  return p.env.SECRET_KEY;
}
