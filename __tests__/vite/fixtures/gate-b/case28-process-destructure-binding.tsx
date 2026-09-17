// Case 28: destructuring straight off the bare `process` binding (not
// `process.env`) — obtains the whole process object via `{ env }`, then
// reads a key off it. The `process` reference itself must be refused.
const { env } = process;

export default function Case28Component() {
  return env.SECRET_KEY;
}
