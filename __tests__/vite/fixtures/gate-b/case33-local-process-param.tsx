// Innocent: "process" as a function PARAMETER is a local binding, not the
// Node global — reading `.env` off it must stay allowed.
function readEnv(process: { env: Record<string, string> }) {
  return process.env.FOO;
}

export default function Case33Component() {
  return readEnv({ env: { FOO: "bar" } });
}
