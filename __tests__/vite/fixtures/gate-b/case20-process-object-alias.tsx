// Case 20: aliases require dataflow and deliberately remain outside Gate B's matcher.
const p = globalThis.process;

export default function Case20Component() {
  return p.env.SECRET_KEY;
}
