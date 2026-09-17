// Innocent: "process" as a local `const` shadows the Node global entirely
// within this module — reading `.env` off it must stay allowed.
const process = { env: { FOO: "bar" } };

export default function Case34Component() {
  return process.env.FOO;
}
