// Case 25: `JSON.stringify(process.env)` — `process.env` passed whole as a
// call argument. Must fail; this serializes every secret value into the
// client bundle.
export default function Case25Component() {
  return JSON.stringify(process.env);
}
