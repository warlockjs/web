import { parse } from "@babel/parser";
import {
  MODULE_CONFIG_KEYS,
  MODULE_EXPORT_NAMES,
  type PageModuleKind,
} from "../module-config-schema";

type Statement = ReturnType<typeof parse>["program"]["body"][number];
type Expression = Extract<Statement, { type: "ExpressionStatement" }>["expression"];
type ObjectExpression = Extract<Expression, { type: "ObjectExpression" }>;
type ObjectProperty = Extract<ObjectExpression["properties"][number], { type: "ObjectProperty" }>;
type ValueNode = ObjectProperty["value"];

export type ModuleConfigRead = {
  route?: { path: string; name?: string };
  prefix?: string;
  strictMode?: boolean;
  hasMiddleware: boolean;
  hasDefault: boolean;
  /**
   * Whether the module declares a runtime `config` export at all, regardless
   * of which (if any) of its fields could be read. Distinguishes "no
   * `config` export" from "a `config` export with nothing this cares about",
   * which {@link route}/{@link prefix}/{@link strictMode} alone cannot: both
   * leave every one of those fields `undefined`.
   */
  hasConfig: boolean;
  /** Present (true) only when the module exports `action` or `actions`. */
  declaresAction?: true;
  /**
   * Page action names read statically: `"default"` for an `action` export, and
   * the keys of an `actions` object literal or `config.actions`. Sorted, unique.
   */
  actionNames?: string[];
};

type ModuleKind = PageModuleKind;

const allowedExports = new Set<string>(MODULE_EXPORT_NAMES);
const configKeys: Record<ModuleKind, ReadonlySet<string>> = {
  page: new Set(MODULE_CONFIG_KEYS.page),
  layout: new Set(MODULE_CONFIG_KEYS.layout),
  root: new Set(MODULE_CONFIG_KEYS.root),
};

function fail(sourceFile: string, detail: string): never {
  throw new Error(`Cannot read module config in "${sourceFile}": ${detail}.`);
}

function unwrap(node: ValueNode): ValueNode {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TypeCastExpression":
    case "ParenthesizedExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}

function stringLiteral(node: ValueNode): string | undefined {
  const value = unwrap(node);
  if (value.type === "StringLiteral") return value.value;
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? value.quasis[0]?.value.raw;
  }
  return undefined;
}

function booleanLiteral(node: ValueNode): boolean | undefined {
  const value = unwrap(node);
  return value.type === "BooleanLiteral" ? value.value : undefined;
}

function propertyName(
  property:
    ObjectProperty | Extract<ObjectExpression["properties"][number], { type: "ObjectMethod" }>,
  sourceFile: string,
): string {
  if (property.computed) fail(sourceFile, "a config object has a computed key");
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "StringLiteral") return property.key.value;
  fail(sourceFile, "a config object has a non-string key");
}

function directObject(node: ValueNode, sourceFile: string, name: string): ObjectExpression {
  const value = unwrap(node);
  if (value.type !== "ObjectExpression") {
    fail(sourceFile, `the \`${name}\` export must be a directly exported object literal`);
  }
  return value;
}

function readRoute(value: ValueNode, sourceFile: string): { path: string; name?: string } {
  const path = stringLiteral(value);
  if (path !== undefined) return { path };

  const object = directObject(value, sourceFile, "config.route");
  let routePath: string | undefined;
  let name: string | undefined;
  const seen = new Set<string>();

  for (const member of object.properties) {
    if (member.type === "SpreadElement")
      fail(sourceFile, "config.route cannot spread another value");
    if (member.type !== "ObjectProperty") fail(sourceFile, "config.route cannot contain a method");
    const key = propertyName(member, sourceFile);
    if (key !== "path" && key !== "name")
      fail(sourceFile, `config.route has unknown key \`${key}\``);
    if (seen.has(key)) fail(sourceFile, `config.route declares \`${key}\` more than once`);
    seen.add(key);
    const literal = stringLiteral(member.value);
    if (literal === undefined) fail(sourceFile, `config.route.\`${key}\` must be a string literal`);
    if (key === "path") routePath = literal;
    else name = literal;
  }

  if (routePath === undefined) fail(sourceFile, "config.route must declare a literal \`path\`");
  return name === undefined ? { path: routePath } : { path: routePath, name };
}

function inspectConfig(
  declarator: { id: { type: string; name?: string }; init?: ValueNode | null },
  sourceFile: string,
  kind: ModuleKind,
): Pick<ModuleConfigRead, "route" | "prefix" | "strictMode" | "hasMiddleware"> & {
  actionKeys: string[];
} {
  if (declarator.id.type !== "Identifier" || declarator.id.name !== "config" || !declarator.init) {
    fail(sourceFile, "the \`config\` export cannot use an alias or destructuring");
  }
  const object = directObject(declarator.init, sourceFile, "config");
  const seen = new Set<string>();
  let route: ModuleConfigRead["route"];
  let prefix: string | undefined;
  let strictMode: boolean | undefined;
  let hasMiddleware = false;
  const actionKeys: string[] = [];

  for (const member of object.properties) {
    if (member.type === "SpreadElement") fail(sourceFile, "config cannot spread another value");
    const key = propertyName(member, sourceFile);
    if (!configKeys[kind].has(key))
      fail(sourceFile, `config key \`${key}\` is not allowed in a ${kind} module`);
    if (seen.has(key)) fail(sourceFile, `config declares \`${key}\` more than once`);
    seen.add(key);

    if (member.type === "ObjectMethod") {
      if (
        member.kind !== "method" ||
        (key !== "metadata" && (kind !== "page" || key !== "sitemap"))
      ) {
        fail(sourceFile, `config.${key} must be a property value, not an accessor or method`);
      }
      continue;
    }

    if (key === "middleware") hasMiddleware = true;
    if (key === "actions") actionKeys.push(...literalKeys(member.value));
    if (key === "route") route = readRoute(member.value, sourceFile);
    if (key === "prefix") {
      const value = stringLiteral(member.value);
      if (value === undefined) fail(sourceFile, "config.prefix must be a string literal");
      prefix = value;
    }
    if (key === "strictMode") {
      const value = booleanLiteral(member.value);
      if (value === undefined) fail(sourceFile, "config.strictMode must be a boolean literal");
      strictMode = value;
    }
  }

  return {
    ...(route === undefined ? {} : { route }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(strictMode === undefined ? {} : { strictMode }),
    hasMiddleware,
    actionKeys,
  };
}

/** Plain-identifier or string keys of an object literal; anything unreadable is skipped. */
function literalKeys(node: ValueNode): string[] {
  const value = unwrap(node);
  if (value.type !== "ObjectExpression") return [];
  const keys: string[] = [];
  for (const member of value.properties) {
    if (member.type === "SpreadElement" || member.computed) continue;
    if (member.key.type === "Identifier") keys.push(member.key.name);
    else if (member.key.type === "StringLiteral") keys.push(member.key.value);
  }
  return keys;
}

/**
 * Statically inspects a page, layout, or root module without loading it.
 * Runtime named exports are deliberately a closed set so misspellings and
 * legacy declarations fail during discovery instead of being silently ignored.
 */
export function readModuleConfig(
  sourceFile: string,
  source: string,
  kind: ModuleKind,
  options: { allowMissingDefault?: boolean } = {},
): ModuleConfigRead {
  let program: ReturnType<typeof parse>["program"];
  try {
    program = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    }).program;
  } catch (error) {
    fail(sourceFile, `the file could not be parsed (${(error as Error).message})`);
  }

  let route: ModuleConfigRead["route"];
  let prefix: string | undefined;
  let strictMode: boolean | undefined;
  let hasMiddleware = false;
  let hasDefault = false;
  let declaresAction = false;
  let hasSingleAction = false;
  const actionNames = new Set<string>();
  let configSeen = false;

  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind !== "type")
        fail(sourceFile, "export-star declarations are not allowed");
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      if ((statement.declaration as { type: string }).type !== "TSInterfaceDeclaration")
        hasDefault = true;
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier")
        fail(sourceFile, "namespace re-exports are not allowed");
      if (specifier.exportKind === "type") continue;
      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported.value;
      if (!allowedExports.has(exported))
        fail(sourceFile, `runtime export \`${exported}\` is not allowed`);
      if (exported === "config")
        fail(sourceFile, "the \`config\` export cannot use an export list or alias");
      if (exported === "default") hasDefault = true;
      if (exported === "action" || exported === "actions") declaresAction = true;
      if (exported === "action") hasSingleAction = true;
    }

    if (!statement.declaration) continue;
    if (statement.declaration.type !== "VariableDeclaration") {
      const declaration = statement.declaration as { id?: { type: string; name?: string } };
      const name = declaration.id?.type === "Identifier" ? declaration.id.name : undefined;
      if (!name || !allowedExports.has(name) || name === "config" || name === "default") {
        fail(
          sourceFile,
          "runtime exports must use one of config, loader, register, ErrorBoundary, or default",
        );
      }
      if (name === "action" || name === "actions") declaresAction = true;
      if (name === "action") hasSingleAction = true;
      continue;
    }
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type !== "Identifier")
        fail(sourceFile, "runtime exports cannot use destructuring");
      const name = declarator.id.name;
      if (!allowedExports.has(name) || name === "default")
        fail(sourceFile, `runtime export \`${name}\` is not allowed`);
      if (name === "action" || name === "actions") declaresAction = true;
      if (name === "action") hasSingleAction = true;
      if (name === "actions" && declarator.init) {
        for (const key of literalKeys(declarator.init as ValueNode)) actionNames.add(key);
      }
      if (name !== "config") continue;
      if (configSeen) fail(sourceFile, "the module declares \`config\` more than once");
      if (statement.declaration.kind !== "const") {
        fail(sourceFile, "the \`config\` export must be declared with \`const\`");
      }
      configSeen = true;
      const read = inspectConfig(declarator, sourceFile, kind);
      route = read.route;
      prefix = read.prefix;
      strictMode = read.strictMode;
      hasMiddleware = read.hasMiddleware;
      for (const key of read.actionKeys) actionNames.add(key);
    }
  }

  if (kind === "page" && !hasDefault && options.allowMissingDefault !== true)
    fail(sourceFile, "a page module requires a runtime default export");
  if (hasSingleAction) actionNames.add("default");
  return {
    ...(route === undefined ? {} : { route }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(strictMode === undefined ? {} : { strictMode }),
    hasMiddleware,
    hasDefault,
    hasConfig: configSeen,
    ...(actionNames.size > 0 ? { actionNames: [...actionNames].sort() } : {}),
    ...(declaresAction ? { declaresAction: true as const } : {}),
  };
}

/**
 * Raised when a page/layout/root module and its setup companion BOTH export
 * `config`.
 *
 * Mirrors the runtime contract a setup file is composed under
 * (`../server/compose-page-module.ts`'s `composePageModule`, which spreads
 * `{ ...uiModule, ...setupModule }` and refuses exactly this): `config` is one
 * export, owned by exactly one file, never assembled field-by-field out of
 * both. Refusing it here, statically, means a build fails with this message
 * instead of quietly reading whichever file happened to come first and
 * shipping a page under the wrong declared name.
 */
export class DuplicateModuleConfigExportError extends Error {
  public constructor(
    public readonly primaryFile: string,
    public readonly setupFile: string,
  ) {
    super(
      `Cannot read module config: both "${primaryFile}" and "${setupFile}" export \`config\`. ` +
        "A module and its setup companion may declare `config` in exactly one file.",
    );
    this.name = "DuplicateModuleConfigExportError";
  }
}

/**
 * Merges a module's own declarations with its optional setup companion's, the
 * STATIC equivalent of the runtime's `composePageModule`.
 *
 * `config` — and therefore `route`/`prefix`/`strictMode`/`hasMiddleware`, all
 * of which live inside it — comes from WHICHEVER of the two files declares
 * it, never unconditionally from the setup file. That is the fix for Real-
 * Estate #15: a page whose `config` needs `typeof loader` types it `satisfies
 * PageConfig<typeof loader>` and keeps `config` in the `.page.tsx` itself,
 * moving only `loader` into the companion `.setup.ts` — so a setup file's
 * mere existence must never make the primary file's own `config` invisible.
 *
 * `action`/`actions` may still live in either file (or both, additively, the
 * way `actionNames`/`declaresAction` already worked before this fix) — those
 * are independent exports the runtime also composes by spreading, and nothing
 * here changes their contract.
 *
 * Takes already-parsed reads (rather than reading files itself) so a caller
 * that already caches `readModuleConfig` per physical file — discovery reads
 * every layout on a page's chain repeatedly — spends no extra parse on this.
 */
export function mergeModuleConfigReads(
  primaryFile: string,
  primaryRead: ModuleConfigRead,
  setupFile: string | undefined,
  setupRead: ModuleConfigRead | undefined,
): ModuleConfigRead {
  if (setupFile === undefined || setupRead === undefined) return primaryRead;

  if (primaryRead.hasConfig && setupRead.hasConfig) {
    throw new DuplicateModuleConfigExportError(primaryFile, setupFile);
  }

  const configOwner = primaryRead.hasConfig
    ? primaryRead
    : setupRead.hasConfig
      ? setupRead
      : undefined;

  const actionNames = [
    ...new Set([...(primaryRead.actionNames ?? []), ...(setupRead.actionNames ?? [])]),
  ].sort();

  return {
    ...(configOwner?.route === undefined ? {} : { route: configOwner.route }),
    ...(configOwner?.prefix === undefined ? {} : { prefix: configOwner.prefix }),
    ...(configOwner?.strictMode === undefined ? {} : { strictMode: configOwner.strictMode }),
    hasMiddleware: configOwner?.hasMiddleware ?? false,
    hasDefault: primaryRead.hasDefault,
    hasConfig: primaryRead.hasConfig || setupRead.hasConfig,
    ...(actionNames.length > 0 ? { actionNames } : {}),
    ...(primaryRead.declaresAction || setupRead.declaresAction
      ? { declaresAction: true as const }
      : {}),
  };
}

/**
 * Reads a module's declarations composed with its optional setup companion in
 * one call, for callers that have no reason to cache the individual reads
 * themselves. See {@link mergeModuleConfigReads} for the composition rule.
 */
export function readComposedModuleConfig(
  primary: { sourceFile: string; source: string },
  setup: { sourceFile: string; source: string } | undefined,
  kind: ModuleKind,
): ModuleConfigRead {
  const primaryRead = readModuleConfig(primary.sourceFile, primary.source, kind, {
    allowMissingDefault: true,
  });

  const setupRead =
    setup === undefined
      ? undefined
      : readModuleConfig(setup.sourceFile, setup.source, kind, { allowMissingDefault: true });

  return mergeModuleConfigReads(primary.sourceFile, primaryRead, setup?.sourceFile, setupRead);
}
