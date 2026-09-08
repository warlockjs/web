import { parse } from "@babel/parser";
import type { Plugin } from "vite";
import { isAppSourcePath, isRecognizedUniversalSurface, isServerFile } from "./gate-a-resolve";
import { isProjectableFile, projectModule } from "./projection";
import { moduleKey } from "../shared/module-key";

export type SsrBoundaryState = {
  readonly appRoot: string;
  readonly clientBoundModules: Set<string>;
  readonly clientImportsByModule: Map<string, Set<string>>;
};

const CODE_MODULE_EXTENSION = /\.([cm]?[jt]sx?)$/;

/**
 * Whether `id` is a client surface WITHOUT having to be reached through the
 * projected-import walk first — the seed set `clientViewOf` marks before any
 * graph traversal has happened.
 *
 * Deliberately asks nothing about WHERE the file lives. A file under
 * `src/web/**` is not, by that location alone, on the client boundary: dev's
 * `middleware`/`loader`/etc. exports are stripped by projection before this
 * function is ever consulted for THEM specifically, and a plain server-only
 * helper reached only through `root.tsx`'s (stripped) `middleware` export —
 * `optional-auth.ts` importing `cookie-session.middleware.ts` — has no route
 * into the surviving graph at all. Location used to override that and refuse
 * it anyway; the boundary is the post-projection import graph, per canon
 * `10f6041c`, the same rule `gate-a-resolve.ts` already enforces by having
 * deliberately removed its own location-based rule 4 (see `ruleViolation`'s
 * comment there). A file that genuinely belongs in the client graph — a
 * `.page.tsx`, a `layout.tsx`, the app root, or anything one of those imports
 * — is still admitted, either directly by `isRecognizedUniversalSurface` or by
 * `resolveId`'s graph walk (`clientBoundModules` / `clientImportsByModule`)
 * once something already in the graph imports it. Nothing under `src/web/**`
 * needs a location exemption to be reached that way.
 */
function isStatelessClientSurface(id: string, appRoot: string): boolean {
  const bare = moduleKey(id);
  if (!isAppSourcePath(bare, appRoot)) return false;
  if (isServerFile(bare, appRoot)) return false;

  return isProjectableFile(bare) || isRecognizedUniversalSurface(bare);
}

function collectImportSpecifiers(code: string): Set<string> {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const imports = new Set<string>();

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const record = node as Record<string, any>;
    if (
      (record.type === "ImportDeclaration" ||
        record.type === "ExportNamedDeclaration" ||
        record.type === "ExportAllDeclaration") &&
      record.source?.type === "StringLiteral"
    ) {
      imports.add(record.source.value);
    }
    if (
      record.type === "CallExpression" &&
      record.callee?.type === "Import" &&
      record.arguments?.[0]?.type === "StringLiteral"
    ) {
      imports.add(record.arguments[0].value);
    }
    if (record.type === "ImportExpression" && record.source?.type === "StringLiteral") {
      imports.add(record.source.value);
    }

    for (const [key, child] of Object.entries(record)) {
      if (
        key === "type" ||
        key === "start" ||
        key === "end" ||
        key === "loc" ||
        key === "range" ||
        key.endsWith("Comments") ||
        key === "extra"
      ) {
        continue;
      }
      walk(child);
    }
  }

  walk(ast.program);
  return imports;
}

function clientViewOf(state: SsrBoundaryState, code: string, id: string): string | undefined {
  const key = moduleKey(id);
  if (!state.clientBoundModules.has(key) && !isStatelessClientSurface(key, state.appRoot)) {
    return undefined;
  }

  state.clientBoundModules.add(key);
  if (!CODE_MODULE_EXTENSION.test(key)) {
    state.clientImportsByModule.set(key, new Set());
    return code;
  }

  const clientCode = isProjectableFile(key) ? projectModule(code, key).code : code;
  state.clientImportsByModule.set(key, collectImportSpecifiers(clientCode));
  return clientCode;
}

function markResolvedClientModule(
  state: SsrBoundaryState,
  resolved: { id: string } | string | null | false | void,
): void {
  if (!resolved) return;
  const id = typeof resolved === "string" ? resolved : resolved.id;
  if (!id.includes("\0")) state.clientBoundModules.add(moduleKey(id));
}

function isServerEnvironment(context: {
  environment?: { config: { consumer?: string } };
}): boolean {
  return context.environment?.config.consumer === "server";
}

/**
 * Keeps the production/client pipeline byte-identical, while giving Gate A
 * and Gate B a validation-only view in Vite's development SSR environment.
 * SSR still evaluates the original source: only the gates receive the
 * projected client view, so loader/server exports retain their legitimate
 * server access while component-visible code is refused before evaluation.
 */
export function clientEnvironmentOnly(plugin: Plugin, ssrState: SsrBoundaryState): Plugin {
  const validatesDevSsr =
    plugin.name === "warlock:gate-a-resolve" || plugin.name === "warlock:gate-b-secrets";
  const originalTransform =
    typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler;
  const originalResolveId =
    typeof plugin.resolveId === "function" ? plugin.resolveId : plugin.resolveId?.handler;
  const originalBuildStart =
    typeof plugin.buildStart === "function" ? plugin.buildStart : plugin.buildStart?.handler;

  return {
    ...plugin,
    applyToEnvironment(environment) {
      return (
        environment.config.consumer === "client" ||
        (validatesDevSsr && environment.config.consumer === "server")
      );
    },
    buildStart: originalBuildStart
      ? function (...args) {
          if (isServerEnvironment(this)) return;
          return originalBuildStart.apply(this, args);
        }
      : undefined,
    transform: originalTransform
      ? async function (code, id, options) {
          if (!isServerEnvironment(this)) {
            return originalTransform.call(this, code, id, options);
          }

          const clientCode = clientViewOf(ssrState, code, id);
          if (clientCode === undefined) return null;

          const transformed = await originalTransform.call(this, clientCode, id, {
            ...options,
            ssr: false,
          });

          // Vite can externalize a package in the SSR environment before its
          // normal resolver walk offers that edge to a plugin. Gate A cannot
          // wait for that walk: validate every import that survived projection
          // now, while the original TypeScript source and importer are known.
          if (plugin.name === "warlock:gate-a-resolve" && originalResolveId) {
            for (const source of ssrState.clientImportsByModule.get(moduleKey(id)) ?? []) {
              const resolved = await originalResolveId.call(this, source, id, {
                attributes: {},
                isEntry: false,
                ssr: false,
              });
              markResolvedClientModule(ssrState, resolved);
            }
          }

          return transformed;
        }
      : undefined,
    resolveId: originalResolveId
      ? async function (source, importer, options) {
          if (!isServerEnvironment(this)) {
            return originalResolveId.call(this, source, importer, options);
          }

          if (!importer) return null;
          const importerKey = moduleKey(importer);
          const isClientBound =
            ssrState.clientBoundModules.has(importerKey) ||
            isStatelessClientSurface(importerKey, ssrState.appRoot);
          if (!isClientBound) return null;

          const survivingImports = ssrState.clientImportsByModule.get(importerKey);
          if (survivingImports && !survivingImports.has(source)) return null;

          const resolved = await originalResolveId.call(this, source, importer, {
            ...options,
            ssr: false,
          });
          markResolvedClientModule(ssrState, resolved);
          return resolved;
        }
      : undefined,
  };
}
