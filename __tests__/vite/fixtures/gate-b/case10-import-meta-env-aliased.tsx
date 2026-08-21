// Case 10 (Part 3, Suki room seq 623): `import.meta.env` aliased to a
// variable — a bare whole-object reference, not narrowed to a single
// "PUBLIC_*" key. Must fail AT TRANSFORM TIME, source-line-pointing.
const env = import.meta.env;

export default function Case10Component() {
  return String(env);
}
