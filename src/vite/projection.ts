/**
 * Projection — the compile-time AST transform that strips a page module's
 * five server exports before the CLIENT graph forms (canon `c604f0bc` §2-3).
 *
 * Removes `export const route/middleware/validation/loader/metadata = ...`
 * (const-arrow form) and `export async function loader(...) {...}`
 * (function-declaration form — `9df6058a` confirms named exports, not a
 * single fused object, so both forms are real), plus any import that becomes
 * unreferenced ONLY as a result of that removal. The default export (the
 * page component) and every other non-server-named export survive
 * unconditionally, regardless of what they reference — classification is by
 * FILE, not by what an export does with data (`c604f0bc` §9).
 *
 * This is NOT Gate A (`resolveId` path refusal), Gate B (inline secret
 * reads) or Gate C (emitted-output verification) — those are separate,
 * later slices. Projection runs first; the gates enforce after.
 */
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Exported so Gate C (`gate-c-verify.ts`) can re-derive "does the emitted
 * bundle contain a server export as a top-level binding" from this exact set
 * rather than hand-typing a second copy that could drift from projection's
 * own list (canon `c604f0bc` §6).
 */
export const SERVER_EXPORT_NAMES = new Set(["route", "middleware", "validation", "loader", "metadata"]);

/**
 * Recognized client-safe assets that always survive projection untouched,
 * whether imported bare (`import "./x.css"`) or with specifiers
 * (`import styles from "./x.module.css"`) — `c604f0bc` §3 names CSS
 * explicitly; the rest of this list is the same "never guess, but a known
 * asset extension is not ambiguous" reasoning extended to the other static
 * asset kinds Vite treats as URL/asset imports, not executable code.
 */
const ASSET_EXTENSION_RE =
  /\.(css|scss|sass|less|styl|stylus|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf)(\?.*)?$/i;

/**
 * Top-level statement types that need no ambiguity check and are never
 * touched by removal: import declarations are handled by their own
 * survives/orphaned logic below, and every export (other than the 5 server
 * names) plus type-only declarations survive unconditionally per
 * `c604f0bc` §9 ("classify FILES, not the data they touch").
 */
const ALWAYS_SAFE_STATEMENT_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "EmptyStatement",
]);

/**
 * Thrown when projection encounters an attribution-ambiguous top-level
 * statement (`c604f0bc` §3: "the compiler must not guess"). Carries the
 * file/statement/fix fields the plugin's `transform` hook formats into the
 * build-failure message — never silently kept or silently dropped.
 */
export class ProjectionAmbiguityError extends Error {
  constructor(
    public readonly file: string,
    public readonly statement: string,
    public readonly line: number,
    public readonly explanation: string,
    public readonly fix: string,
  ) {
    super(
      [
        `Projection refused to guess: an ambiguous top-level statement in the client build.`,
        ``,
        `File: ${file}:${line}`,
        `Statement: ${statement}`,
        `Cause: ${explanation}`,
        `Fix: ${fix}`,
      ].join("\n"),
    );
    this.name = "ProjectionAmbiguityError";
  }
}

export interface ProjectionResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

function isKnownSafeAsset(source: string): boolean {
  return ASSET_EXTENSION_RE.test(source);
}

/**
 * Matches `export const <name> = ...` only when the declaration has exactly
 * one declarator — every server export in every fixture and v5/app page is
 * written one-const-per-export (`product-details.page.tsx:15-18,42-69,71-74`);
 * a multi-declarator `export const a = 1, b = 2` is left to the ambiguity
 * path below rather than guessing which half is server-only.
 */
function isServerExportDeclaration(stmt: any): boolean {
  if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) return false;
  const decl = stmt.declaration;
  if (decl.type === "VariableDeclaration" && decl.declarations.length === 1) {
    const id = decl.declarations[0].id;
    return id?.type === "Identifier" && SERVER_EXPORT_NAMES.has(id.name);
  }
  if (decl.type === "FunctionDeclaration") {
    return !!decl.id && SERVER_EXPORT_NAMES.has(decl.id.name);
  }
  return false;
}

/**
 * Generic duck-typed AST walk (no `@babel/traverse` dependency — this
 * package only needs `@babel/parser` + `@babel/types`-shaped nodes).
 * Collects every `Identifier`/`JSXIdentifier` name reachable from `node`,
 * used to decide whether an import binding still has a reader once the 5
 * server exports are gone. Over-collecting (e.g. counting an object
 * property key as a "use") only ever biases toward KEEPING an import, never
 * toward dropping one that is still needed — the safe direction for a
 * heuristic that must not guess in the removal direction.
 */
function collectIdentifierNames(node: unknown, names: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifierNames(item, names);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string") return;
  if (record.type === "Identifier" || record.type === "JSXIdentifier") {
    names.add((record as any).name);
  }
  for (const key of Object.keys(record)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") {
      continue;
    }
    collectIdentifierNames(record[key], names);
  }
}

function removeStatement(s: MagicString, code: string, node: any): void {
  let end = node.end as number;
  // Swallow one trailing newline so a removed statement doesn't leave a
  // blank line behind — cosmetic only, the output's correctness never
  // depends on it.
  if (code[end] === "\r" && code[end + 1] === "\n") end += 2;
  else if (code[end] === "\n") end += 1;
  s.remove(node.start as number, end);
}

function statementSnippet(code: string, node: any): string {
  return code.slice(node.start as number, node.end as number).split("\n")[0].trim();
}

/**
 * The transform itself: parse, remove the 5 server exports and every import
 * orphaned only by that removal, fail closed on anything attribution-
 * ambiguous. `filePath` is only used for error messages (`c604f0bc` §7 —
 * fence errors must name the file).
 */
export function projectModule(code: string, filePath: string): ProjectionResult {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const s = new MagicString(code);
  const body = ast.program.body as any[];

  const removedServerExports: any[] = [];
  const importDeclarations: any[] = [];

  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration") {
      importDeclarations.push(stmt);
      continue;
    }
    if (isServerExportDeclaration(stmt)) {
      removedServerExports.push(stmt);
      continue;
    }
    if (ALWAYS_SAFE_STATEMENT_TYPES.has(stmt.type)) continue;

    // Attribution-ambiguous: not an import, not one of the 5 known server
    // exports, not another export, not a type-only declaration. Fail closed
    // rather than guess which side of the fence it belongs on (`c604f0bc` §3).
    throw new ProjectionAmbiguityError(
      filePath,
      statementSnippet(code, stmt),
      stmt.loc.start.line,
      `top-level executable code outside the 5 known server exports (route, middleware, validation, loader, metadata) — projection can't tell whether it belongs to the server or the client`,
      `mark it with an explicit .server/.client file, or move it inside one of the 5 declared server exports (if server-only) or the default export/a component (if client-safe)`,
    );
  }

  // Identify import bindings that still have a reader once the 5 server
  // exports are gone: walk every surviving top-level statement (imports
  // themselves excluded, so an import specifier never counts as a use of
  // itself).
  const survivingNames = new Set<string>();
  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration" || removedServerExports.includes(stmt)) continue;
    collectIdentifierNames(stmt, survivingNames);
  }

  for (const decl of importDeclarations) {
    const source = decl.source.value as string;
    if (isKnownSafeAsset(source)) continue; // always survives, no orphan check

    if (decl.specifiers.length === 0) {
      // A bare side-effect import that isn't a recognized asset extension is
      // just as attribution-ambiguous as an executable statement — could be
      // a server-only side effect or something the client genuinely needs.
      throw new ProjectionAmbiguityError(
        filePath,
        statementSnippet(code, decl),
        decl.loc.start.line,
        `a bare side-effect import with no recognized client-safe asset extension — projection can't tell if it belongs only to the server exports being removed or must ship to the client`,
        `mark it with an explicit .server/.client file, or move it inside one of the 5 declared server exports if it's server-only`,
      );
    }

    const isUsed = decl.specifiers.some((spec: any) => survivingNames.has(spec.local.name));
    if (!isUsed) removeStatement(s, code, decl);
  }

  for (const stmt of removedServerExports) {
    removeStatement(s, code, stmt);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: filePath }),
  };
}

function isProjectableFile(id: string): boolean {
  const base = path.basename(id.split("?")[0]);
  if (/\.page\.tsx?$/.test(base)) return true;
  if (base === "layout.tsx" || base === "layout.ts") return true;
  if (base === "App.tsx") return true;
  return false;
}

/**
 * The client-build Vite plugin. Scoped to `*.page.tsx`/`layout.tsx`/`App.tsx`
 * and skipped entirely for the SSR build (`options.ssr`) — the server still
 * needs `route`/`middleware`/`validation`/`loader`/`metadata` intact.
 */
export function projection(): Plugin {
  return {
    name: "warlock:projection",
    enforce: "pre",
    transform(code, id, options) {
      if (options?.ssr) return null;
      if (!isProjectableFile(id)) return null;

      try {
        const { code: transformed, map } = projectModule(code, id);
        return { code: transformed, map };
      } catch (error) {
        if (error instanceof ProjectionAmbiguityError) {
          this.error(error.message);
        }
        throw error;
      }
    },
  };
}
