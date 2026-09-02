// Case 24: `Object.keys(process.env)` — `process.env` passed whole as a call
// argument. Must fail; enumerating the keys leaks which secrets exist.
export default function Case24Component() {
  return Object.keys(process.env);
}
