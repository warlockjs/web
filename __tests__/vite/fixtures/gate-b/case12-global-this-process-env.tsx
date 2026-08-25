// Case 12: process.env reached through globalThis must still fail.
export default function Case12Component() {
  return globalThis.process.env.SECRET_KEY;
}
