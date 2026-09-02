// Case 22: `process.env` spread into an object literal passed as a call
// argument — a bare whole-object reference. Must fail AT TRANSFORM TIME,
// source-line-pointing, mirroring case 11's import.meta.env coverage.
function describeEnv(env: Record<string, unknown>) {
  return JSON.stringify(env);
}

export default function Case22Component() {
  return describeEnv({ ...process.env });
}
