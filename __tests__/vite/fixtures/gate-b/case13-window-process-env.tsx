// Case 13: process.env reached through window must still fail.
export default function Case13Component() {
  return window.process.env.SECRET_KEY;
}
