// Case 21: `process.env` aliased to a variable — a bare whole-object
// reference, not narrowed to a single key. Must fail AT TRANSFORM TIME,
// source-line-pointing, mirroring case 10's import.meta.env coverage.
const env = process.env;

export default function Case21Component() {
  return String(env);
}
