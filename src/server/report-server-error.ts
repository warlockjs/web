/**
 * The unconditional stderr floor for a server-side failure that must never be
 * silenced by a configurable sink alone (canon `8d3c13a8`) — `render-page.ts`'s
 * `reportRenderError` established this convention for a render-time throw
 * before this card existed. Deferred rejections and timeouts (Stage 2 rule 7)
 * need the identical floor, so this gives the ONE convention a shared,
 * exported name instead of a second ad hoc `console.error` call site.
 */
export function reportServerError(context: string, thrown: unknown): void {
  console.error(`[warlock:web] ${context}:`, thrown);
}
