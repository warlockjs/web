// Case 1: process.env.SECRET_KEY read via dot notation, in a plain
// component (not a page) — must fail, no matter the file kind.
export default function Case1Component() {
  return process.env.SECRET_KEY;
}
