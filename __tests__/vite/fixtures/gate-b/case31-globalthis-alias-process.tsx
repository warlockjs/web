// Case 31: `globalThis` itself aliased to a variable first, THEN
// `.process.env` read off that alias — two hops of indirection.
const g = globalThis;

export default function Case31Component() {
  return g.process.env.SECRET_KEY;
}
