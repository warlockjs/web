// Case 15: a static bracket read of process through globalThis must fail.
export default function Case15Component() {
  return globalThis["process"].env.SECRET_KEY;
}
