// A plain helper file, not a page — the secret read lives here to prove
// Gate B applies to every module Vite processes, not just *.page.tsx files.
export function readSecret() {
  return process.env.SECRET_KEY;
}
