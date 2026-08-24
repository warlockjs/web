import type {
  ClientPageEntry,
  ClientProjectedModule,
  ClientRouteComposition,
} from "./types";

const ENTRY_KEYS = ["type", "name", "path", "load"] as const;
const COMPOSITION_REQUIRED_KEYS = ["Page", "layouts"] as const;
const COMPOSITION_OPTIONAL_KEYS = ["App"] as const;

type DataRecord = Record<PropertyKey, unknown>;

function isNonArrayObject(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printableValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);

  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

function assertExactDataKeys(
  value: DataRecord,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);

  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(`${label} has unexpected own key ${JSON.stringify(String(key))}.`);
    }
  }

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw new TypeError(`${label} is missing own key ${JSON.stringify(key)}.`);
    }
  }

  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) {
      throw new TypeError(
        `${label} key ${JSON.stringify(String(key))} must be an own data property.`,
      );
    }
  }
}

function validateEntry(input: unknown, index: number): ClientPageEntry {
  const label = `Client route manifest entry at index ${index}`;

  if (!isNonArrayObject(input)) {
    throw new TypeError(`${label} must be a non-array object.`);
  }

  assertExactDataKeys(input, ENTRY_KEYS, [], label);

  if (input.type !== "page") {
    throw new TypeError(
      `${label} has unknown type ${printableValue(input.type)}; expected "page".`,
    );
  }

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new TypeError(`${label} name must be a non-empty string.`);
  }

  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    throw new TypeError(`${label} path must be a non-empty string.`);
  }

  if (typeof input.load !== "function") {
    throw new TypeError(`${label} load must be callable.`);
  }

  return input as ClientPageEntry;
}

function validateProjectedModule(input: unknown, label: string): ClientProjectedModule {
  if (!isNonArrayObject(input)) {
    throw new TypeError(`${label} must be a non-array module object.`);
  }

  return input;
}

function validateComposition(input: unknown): ClientRouteComposition {
  const label = "Loaded client route composition";

  if (!isNonArrayObject(input)) {
    throw new TypeError(`${label} must be a non-array object.`);
  }

  assertExactDataKeys(
    input,
    COMPOSITION_REQUIRED_KEYS,
    COMPOSITION_OPTIONAL_KEYS,
    label,
  );
  validateProjectedModule(input.Page, `${label} Page`);

  if (!Array.isArray(input.layouts)) {
    throw new TypeError(`${label} layouts must be an array.`);
  }

  input.layouts.forEach((layout, index) => {
    validateProjectedModule(layout, `${label} layout at index ${index}`);
  });

  if (Object.prototype.hasOwnProperty.call(input, "App")) {
    validateProjectedModule(input.App, `${label} App`);
  }

  return input as ClientRouteComposition;
}

export function validateClientRouteManifest(input: unknown): readonly ClientPageEntry[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Client route manifest must be an array.");
  }

  const names = new Set<string>();
  const paths = new Set<string>();

  return input.map((candidate, index) => {
    const entry = validateEntry(candidate, index);

    if (names.has(entry.name)) {
      throw new TypeError(
        `Client route manifest has duplicate name ${JSON.stringify(entry.name)}.`,
      );
    }

    if (paths.has(entry.path)) {
      throw new TypeError(
        `Client route manifest has duplicate path ${JSON.stringify(entry.path)}.`,
      );
    }

    names.add(entry.name);
    paths.add(entry.path);
    return entry;
  });
}

export async function loadClientRouteComposition(
  entry: ClientPageEntry,
): Promise<ClientRouteComposition> {
  const loaded = await entry.load();
  return validateComposition(loaded);
}
