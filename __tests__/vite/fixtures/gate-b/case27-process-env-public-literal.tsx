// Case 27: `process.env.PUBLIC_API_URL` — a "PUBLIC_"-prefixed literal key
// read off `process.env` (not `import.meta.env`). See the spec file for why
// this fixture asserts a FAILURE, not a pass.
export default function Case27Component() {
  return process.env.PUBLIC_API_URL;
}
