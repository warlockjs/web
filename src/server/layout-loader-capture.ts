import type { PipelineLoaderContext } from "./execute-page-request";

/**
 * Per-invocation storage for the individual values a composed layout loader
 * produces. The composed loader itself remains a normal PipelineLoader and
 * returns only its rendering host's value; this side channel exists solely
 * until metadata has consumed the ordered values during the same request.
 */
const captures = new WeakMap<PipelineLoaderContext, unknown[]>();

export function beginLayoutLoaderCapture(context: PipelineLoaderContext, values: unknown[]): void {
  captures.set(context, values);
}

export function recordLayoutLoaderValue(
  context: PipelineLoaderContext,
  index: number,
  value: unknown,
): void {
  captures.get(context)?.splice(index, 1, value);
}

export function endLayoutLoaderCapture(context: PipelineLoaderContext): void {
  captures.delete(context);
}
