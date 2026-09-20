import type { LayoutModuleShape } from "./page-module-shapes";

function sourceName(sourceFiles: readonly string[] | undefined, index: number): string {
  return sourceFiles?.[index] ?? `layout module at index ${index}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function validateLayoutMetadata(metadata: unknown, sourceFile: string): string | undefined {
  if (metadata === undefined) return undefined;

  if (!isPlainObject(metadata)) {
    throw new TypeError(`Layout "${sourceFile}" metadata must be a plain static object.`);
  }

  for (const key of Object.keys(metadata)) {
    if (key !== "robots") {
      throw new TypeError(`Layout "${sourceFile}" metadata only supports the "robots" key.`);
    }
  }

  const robots = metadata.robots;

  if (robots !== undefined && typeof robots !== "string") {
    throw new TypeError(`Layout "${sourceFile}" metadata.robots must be a string when defined.`);
  }

  return robots;
}

/** Resolves the closest static robots directive after validating every layout in the chain. */
export function resolveLayoutRobots(
  modules: readonly LayoutModuleShape[],
  sourceFiles?: readonly string[],
): string | undefined {
  let robots: string | undefined;

  modules.forEach((module, index) => {
    const candidate = validateLayoutMetadata(module.metadata, sourceName(sourceFiles, index));

    if (candidate !== undefined) robots = candidate;
  });

  return robots;
}
