export type RouteLocaleKeySource = {
  sourceFile: string;
  entries: Record<string, Record<string, string>>;
};

/**
 * Rejects global duplicate keys and a key that would need to be both a leaf
 * and an object namespace. It depends only on parsed source definitions, so
 * build serialization can enforce the same ownership floor before runtime
 * locale configuration is available.
 */
export function assertRouteLocaleKeyOwnership(sources: readonly RouteLocaleKeySource[]): string[] {
  const ownerByKey = new Map<string, string>();

  for (const source of sources) {
    for (const key of Object.keys(source.entries)) {
      const existing = ownerByKey.get(key);
      if (existing !== undefined) {
        throw new Error(
          `Route locale key ${JSON.stringify(key)} is declared by both ${JSON.stringify(existing)} and ${JSON.stringify(source.sourceFile)}.`,
        );
      }
      ownerByKey.set(key, source.sourceFile);
    }
  }

  for (const key of ownerByKey.keys()) {
    let separator = key.indexOf(".");
    while (separator !== -1) {
      const prefix = key.slice(0, separator);
      const owner = ownerByKey.get(prefix);
      if (owner !== undefined) {
        throw new Error(
          `Route locale key ${JSON.stringify(prefix)} in ${JSON.stringify(owner)} conflicts with namespace key ${JSON.stringify(key)} in ${JSON.stringify(ownerByKey.get(key))}.`,
        );
      }
      separator = key.indexOf(".", separator + 1);
    }
  }

  return [...ownerByKey.keys()].sort();
}
