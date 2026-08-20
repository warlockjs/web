// Case 9's helper module: part of the client build, but never reads either
// PUBLIC_* env var declared for this fixture — it exists to prove the unread
// one isn't inlined by SOME OTHER module either, not just the entry.
export function helperGreeting(): string {
  return "hello from case9 helper";
}
