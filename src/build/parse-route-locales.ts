import path from "node:path";

export type RouteLocaleEntries = Record<string, Record<string, string>>;

export type ParsedRouteLocaleFile = {
  sourceFile: string;
  webRoot: string;
  group: string;
  entries: RouteLocaleEntries;
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = Map<string, JsonValue>;

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LOCALE_CODE = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** A source error that always names both the locale file and the offending JSON key. */
export class RouteLocaleFileError extends Error {
  public constructor(
    public readonly sourceFile: string,
    public readonly key: string,
    detail: string,
  ) {
    super(`Cannot parse route locales in "${sourceFile}" at "${key}": ${detail}.`);
    this.name = "RouteLocaleFileError";
  }
}

function fail(sourceFile: string, key: string, detail: string): never {
  throw new RouteLocaleFileError(sourceFile, key, detail);
}

/** A deliberately small JSON parser: unlike JSON.parse, it preserves duplicate property names. */
class StrictJsonParser {
  private offset = 0;

  public constructor(
    private readonly sourceFile: string,
    private readonly source: string,
  ) {}

  public parse(): JsonValue {
    const value = this.value("$");
    this.whitespace();

    if (this.offset !== this.source.length) this.invalid("$", "unexpected trailing JSON");
    return value;
  }

  private value(key: string): JsonValue {
    this.whitespace();
    const character = this.source[this.offset];

    if (character === "{") return this.object(key);
    if (character === "[") return this.array(key);
    if (character === '"') return this.string(key);
    if (this.source.startsWith("true", this.offset)) return this.literal("true", true);
    if (this.source.startsWith("false", this.offset)) return this.literal("false", false);
    if (this.source.startsWith("null", this.offset)) return this.literal("null", null);
    if (character === "-" || (character !== undefined && /[0-9]/.test(character))) {
      return this.number(key);
    }

    this.invalid(key, "invalid JSON value");
  }

  private object(key: string): JsonObject {
    this.offset++;
    this.whitespace();
    const object = new Map<string, JsonValue>();

    if (this.source[this.offset] === "}") {
      this.offset++;
      return object;
    }

    while (true) {
      this.whitespace();
      if (this.source[this.offset] !== '"') this.invalid(key, "object keys must be JSON strings");
      const property = this.string(key);
      const propertyKey = `${key}.${property}`;

      if (object.has(property)) this.invalid(propertyKey, "duplicate JSON property");

      this.whitespace();
      if (this.source[this.offset] !== ":")
        this.invalid(propertyKey, "expected ':' after object key");
      this.offset++;
      object.set(property, this.value(propertyKey));
      this.whitespace();

      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset++;
        return object;
      }
      if (separator !== ",") this.invalid(key, "expected ',' or '}' in object");
      this.offset++;
    }
  }

  private array(key: string): JsonValue[] {
    this.offset++;
    this.whitespace();
    const values: JsonValue[] = [];

    if (this.source[this.offset] === "]") {
      this.offset++;
      return values;
    }

    while (true) {
      values.push(this.value(key));
      this.whitespace();
      const separator = this.source[this.offset];

      if (separator === "]") {
        this.offset++;
        return values;
      }
      if (separator !== ",") this.invalid(key, "expected ',' or ']' in array");
      this.offset++;
    }
  }

  private string(key: string): string {
    const start = this.offset++;
    let escaped = false;

    while (this.offset < this.source.length) {
      const character = this.source[this.offset++];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          this.invalid(key, "invalid JSON string");
        }
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) {
        this.invalid(key, "unescaped control character in JSON string");
      }
    }

    this.invalid(key, "unterminated JSON string");
  }

  private number(key: string): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.offset;
    const token = match.exec(this.source)?.[0];

    if (token === undefined) this.invalid(key, "invalid JSON number");
    this.offset += token.length;
    return Number(token);
  }

  private literal<T extends boolean | null>(written: string, value: T): T {
    this.offset += written.length;
    return value;
  }

  private whitespace(): void {
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];

      if (character === undefined || !" \t\n\r".includes(character)) return;
      this.offset++;
    }
  }

  private invalid(key: string, detail: string): never {
    fail(this.sourceFile, key, detail);
  }
}

function namespaceFor(sourceFile: string, webRoot: string): string {
  const relativeDirectory = path.relative(webRoot, path.dirname(sourceFile));

  if (relativeDirectory === "") return "";
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`)) {
    fail(sourceFile, "$group", "file is outside the web root");
  }

  const segments = relativeDirectory
    .split(path.sep)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !(segment.startsWith("[") && segment.endsWith("]")));

  for (const segment of segments) assertNamespaceSegment(sourceFile, segment, "$group");

  return segments.join(".");
}

function assertFileWithinWebRoot(sourceFile: string, webRoot: string): void {
  const relativeFile = path.relative(webRoot, sourceFile);

  if (
    relativeFile === ".." ||
    relativeFile.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFile)
  ) {
    fail(sourceFile, "$", "file is outside the web root");
  }
}

function assertNamespaceSegment(sourceFile: string, segment: string, key: string): void {
  if (!SEGMENT.test(segment)) fail(sourceFile, key, "segments must match [A-Za-z_][A-Za-z0-9_-]*");
  if (FORBIDDEN_SEGMENTS.has(segment)) fail(sourceFile, key, "segments cannot be reserved");
}

function assertSegment(sourceFile: string, segment: string, key: string): void {
  if (segment.includes(".")) fail(sourceFile, key, "JSON keys cannot contain '.'");
  assertNamespaceSegment(sourceFile, segment, key);
}

function explicitGroup(sourceFile: string, value: string): string {
  if (value === "") fail(sourceFile, "$group", "'$group' cannot be empty");

  for (const segment of value.split(".")) {
    if (segment === "") fail(sourceFile, "$group", "'$group' cannot contain empty segments");
    assertNamespaceSegment(sourceFile, segment, "$group");
  }

  return value;
}

function isObject(value: JsonValue): value is JsonObject {
  return value instanceof Map;
}

function readLeaf(
  sourceFile: string,
  key: string,
  value: JsonObject,
  localeCodes: readonly string[] | undefined,
): Record<string, string> {
  const locales = localeCodes === undefined ? undefined : new Set(localeCodes);
  const entry: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const [locale, translation] of value) {
    if (!LOCALE_CODE.test(locale)) fail(sourceFile, `${key}.${locale}`, "invalid locale code");
    if (typeof translation !== "string")
      fail(sourceFile, `${key}.${locale}`, "locale values must be strings");
    if (locales !== undefined && !locales.has(locale)) {
      fail(sourceFile, `${key}.${locale}`, "unknown locale code");
    }
    entry[locale] = translation;
  }

  if (localeCodes !== undefined) {
    for (const locale of localeCodes) {
      if (!(locale in entry)) fail(sourceFile, key, `missing locale code "${locale}"`);
    }
  }

  return entry;
}

function collectEntries(
  sourceFile: string,
  object: JsonObject,
  group: string,
  localeCodes: readonly string[] | undefined,
  entries: RouteLocaleEntries,
  nested: boolean,
): void {
  if (nested && object.size === 0) fail(sourceFile, group, "nested objects cannot be empty");

  for (const [segment, value] of object) {
    const key = group === "" ? segment : `${group}.${segment}`;

    if (segment === "$group") {
      fail(sourceFile, key, "'$group' is only allowed at the root");
    }
    assertSegment(sourceFile, segment, key);
    if (!isObject(value)) fail(sourceFile, key, "entries must be locale objects or nested objects");
    if (value.has("$group"))
      fail(sourceFile, `${key}.$group`, "'$group' is only allowed at the root");

    const values = [...value.values()];
    const hasString = values.some((item) => typeof item === "string");
    const allObjects = values.every(isObject);

    if (hasString) {
      if (!values.every((item) => typeof item === "string")) {
        fail(sourceFile, key, "cannot mix locale values with nested entries");
      }
      entries[key] = readLeaf(sourceFile, key, value, localeCodes);
      continue;
    }

    if (!allObjects) fail(sourceFile, key, "cannot mix locale values with nested entries");

    if (
      localeCodes !== undefined &&
      [...value.keys()].some((child) => localeCodes.includes(child))
    ) {
      fail(sourceFile, key, "cannot mix locale codes with nested entries");
    }

    collectEntries(sourceFile, value, key, localeCodes, entries, true);
  }
}

/**
 * Parses one route-locales JSON source without reading the filesystem or loading application code.
 */
export function parseRouteLocaleFile(input: {
  sourceFile: string;
  webRoot: string;
  source: string;
  localeCodes?: readonly string[];
}): ParsedRouteLocaleFile {
  const { sourceFile, webRoot, source, localeCodes } = input;
  assertFileWithinWebRoot(sourceFile, webRoot);
  const parsed = new StrictJsonParser(sourceFile, source).parse();

  if (!isObject(parsed)) fail(sourceFile, "$", "root JSON value must be an object");

  const groupValue = parsed.get("$group");

  if (groupValue !== undefined && typeof groupValue !== "string") {
    fail(sourceFile, "$group", "'$group' must be a string");
  }
  const group =
    groupValue === undefined
      ? namespaceFor(sourceFile, webRoot)
      : explicitGroup(sourceFile, groupValue);

  const entries: RouteLocaleEntries = Object.create(null) as RouteLocaleEntries;
  const rootEntries = new Map(parsed);
  rootEntries.delete("$group");

  collectEntries(sourceFile, rootEntries, group, localeCodes, entries, false);

  return { sourceFile, webRoot, group, entries };
}
