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
): Pick<ModuleConfigRead, "route" | "prefix" | "strictMode" | "hasMiddleware"> {
  if (declarator.id.type !== "Identifier" || declarator.id.name !== "config" || !declarator.init) {
    fail(sourceFile, "the \`config\` export cannot use an alias or destructuring");
  }
  const object = directObject(declarator.init, sourceFile, "config");
  const seen = new Set<string>();
  let route: ModuleConfigRead["route"];
  let prefix: string | undefined;
  let strictMode: boolean | undefined;
  let hasMiddleware = false;

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
        kind !== "page" ||
        (key !== "metadata" && key !== "sitemap")
      ) {
        fail(sourceFile, `config.${key} must be a property value, not an accessor or method`);
      }
      continue;
    }

    if (key === "middleware") hasMiddleware = true;
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
  };
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
      continue;
    }
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type !== "Identifier")
        fail(sourceFile, "runtime exports cannot use destructuring");
      const name = declarator.id.name;
      if (!allowedExports.has(name) || name === "default")
        fail(sourceFile, `runtime export \`${name}\` is not allowed`);
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
    }
  }

  if (kind === "page" && !hasDefault)
    fail(sourceFile, "a page module requires a runtime default export");
  return {
    ...(route === undefined ? {} : { route }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(strictMode === undefined ? {} : { strictMode }),
    hasMiddleware,
    hasDefault,
  };
}
