// Case 14: process.env reached through self must still fail.
export default function Case14Component() {
  return self.process.env.SECRET_KEY;
}
