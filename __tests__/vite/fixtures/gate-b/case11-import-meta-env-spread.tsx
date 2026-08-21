// Case 11 (Part 3, Suki room seq 623): `import.meta.env` spread into an
// object literal passed as a call argument — a bare whole-object reference.
// Must fail AT TRANSFORM TIME, source-line-pointing.
function describeEnv(env: Record<string, unknown>) {
  return JSON.stringify(env);
}

export default function Case11Component() {
  return describeEnv({ ...import.meta.env });
}
