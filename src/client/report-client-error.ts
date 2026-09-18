/**
 * The unconditional console floor for a client-side failure that must never
 * be silenced by a configurable sink alone — mirrors `report-server-error.ts`'s
 * identical convention for the server half of this pipeline.
 */
export function reportClientError(context: string, thrown: unknown): void {
  console.error(`[warlock:web] ${context}:`, thrown);
}
