// Innocent: "process" used as an object property KEY (and read back via
// dot-member on a plain object literal, not globalThis/window/self) is not
// a reference to the Node global at all.
const obj = { process: 1 };

export default function Case35Component() {
  return obj.process;
}
