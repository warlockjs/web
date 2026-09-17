// Innocent: "process" appears only in a TYPE position (`typeof process.env`
// as a parameter type annotation) — erased at compile time, never a runtime
// reference to the Node global.
function readEnv(env: typeof process.env) {
  return env;
}

export default function Case38Component() {
  return readEnv === readEnv ? "ok" : "unreachable";
}
