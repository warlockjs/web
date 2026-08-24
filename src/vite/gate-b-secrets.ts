/**
 * Gate B — an AST transform gate for inline secrets.
 *
 * `resolveId` (Gate A) refuses import PATHS; it cannot see a bare property
 * read like `process.env.SECRET` or `import.meta.env.SOME_KEY` — there is no
 * import to refuse, just a member expression. Gate B is the orthogonal,
 * transform-time check that catches exactly that class. It is applied to
 * EVERY module Vite processes in the client build — NOT scoped to
 * `*.page.tsx` like projection, because a secret can leak from any helper,
 * component, or shared util, not only from a page file.
 *
 * The PUBLIC_ env-var convention this gate enforces is DEFINED here and
 * nowhere else: a client module may read
 * `import.meta.env.X` only when `X` starts with `PUBLIC_`. `process.env` is
 * never readable client-side at all — Node's `process` object does not exist
 * in the browser, so any static or computed read of `process.env.X` is
 * forbidden regardless of `X`.
 *
 * Gate A, Gate C and the SSR mirror rule are NOT this gate. Do not extend
 * this file to cover them; they are separate slices.
 *
 * A bare `import.meta.env` reference — used as a value directly (passed as
 * an argument, spread, destructured, or aliased to a variable) rather than
 * narrowed to a single static `.KEY` access — is caught here too: it leaks
 * the WHOLE env object, not one var, so it is the most
 * severe violation this gate judges, and is caught at the exact source line
 * like every other Gate B violation, not only as a whole-build
 * `generateBundle` failure. See `findViolation`'s `consumedEnvBases` note.
 */
import { parse } from "@babel/parser";
import type { Plugin } from "vite";

const PUBLIC_ENV_PREFIX = "PUBLIC_";

/**
 * Vite injects these five `import.meta.env` keys itself (vite's own
 * `resolveConfig`: `env: { ...userEnv, BASE_URL, MODE, DEV, PROD }`, plus
 * `SSR` set per-environment by vite's `vite:define` plugin) — they are
 * framework metadata, not app secrets, and are legitimately readable
 * client-side with no `PUBLIC_` prefix. Named explicitly here so a future
 * false positive against these doesn't get
 * "fixed" by widening the PUBLIC_ rule instead of consulting this allowlist.
 */
const VITE_BUILTIN_ENV_KEYS = new Set(["MODE", "DEV", "PROD", "BASE_URL", "SSR"]);

const JS_MODULE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

function isJsModule(id: string): boolean {
  return JS_MODULE_EXTENSIONS.test(id.split("?")[0]);
}

/**
 * Third-party dependencies (React among them) commonly guard dev-only code
 * with `process.env.NODE_ENV` checks that Vite's own dependency
 * pre-bundling/define step is responsible for handling — Gate B judges this
 * app's own source, not a vendor package's internal layout, the same
 * "dependency internals are out of scope" call Gate A's rule 4 makes for
 * `$module/web/` classification.
 */
function isNodeModulesFile(id: string): boolean {
  return /(^|[\\/])node_modules([\\/]|$)/.test(id);
}

/**
 * Generic duck-typed AST walk (mirrors `projection.ts`'s `collectIdentifierNames`
 * — no `@babel/traverse` dependency, this package only needs `@babel/parser`).
 * Visits every node in the tree, including nested function bodies and JSX
 * expression containers, so a secret read buried inside a callback or a
 * conditional is caught just as one at the top level is.
 */
function walk(node: unknown, visit: (node: Record<string, any>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as Record<string, any>;
  if (typeof record.type !== "string") return;
  visit(record);
  for (const key of Object.keys(record)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") {
      continue;
    }
    walk(record[key], visit);
  }
}

function isIdentifierNamed(node: any, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

/** Matches the `process.env` member expression itself (dot or static-bracket). */
function isProcessEnvBase(node: any): boolean {
  if (node?.type !== "MemberExpression") return false;
  if (!isIdentifierNamed(node.object, "process")) return false;
  if (!node.computed) return isIdentifierNamed(node.property, "env");
  return node.property?.type === "StringLiteral" && node.property.value === "env";
}

/** Matches the `import.meta.env` member expression itself (dot or static-bracket). */
function isImportMetaEnvBase(node: any): boolean {
  if (node?.type !== "MemberExpression") return false;
  const object = node.object;
  if (object?.type !== "MetaProperty") return false;
  if (object.meta?.name !== "import" || object.property?.name !== "meta") return false;
  if (!node.computed) return isIdentifierNamed(node.property, "env");
  return node.property?.type === "StringLiteral" && node.property.value === "env";
}

type KeyResolution = { readonly static: true; readonly key: string } | { readonly static: false };

/**
 * Resolves the key an outer `<base>.<key>` / `<base>[<key>]` member
 * expression reads off `process.env` or `import.meta.env`. Only a literal
 * dot-property or a static string-literal bracket key counts as static —
 * anything else (a variable, a template literal, a call expression, ...) is
 * a computed key and must fail closed (`c604f0bc` §5 / §3 "never guess").
 */
function resolveKey(outer: any): KeyResolution {
  if (!outer.computed) {
    if (outer.property?.type === "Identifier") return { static: true, key: outer.property.name };
    return { static: false };
  }
  if (outer.property?.type === "StringLiteral") return { static: true, key: outer.property.value };
  return { static: false };
}

function expressionText(code: string, node: any): string {
  return code.slice(node.start as number, node.end as number);
}

/**
 * Tracks which declared `PUBLIC_*` keys were actually read anywhere in the
 * client build, and the resolved env values Vite would inline for them.
 * Shared, by construction, between `gateBSecrets` (which owns the writes —
 * `transform`'s `onPublicKeyRead` callback, `configResolved`'s declared-env
 * snapshot) and Gate C's inlined-value manifest (`gate-c-verify.ts`), so the
 * manifest's "was this key actually inlined" list and Gate B's own
 * unread-key exclusion (`generateBundle` below) can never drift apart into
 * two different answers — they read the same `Set`/object, not two
 * independently-recomputed ones.
 */
export interface PublicEnvTracker {
  readonly referencedKeys: Set<string>;
  declaredEnv: Record<string, unknown>;
}

export function createPublicEnvTracker(): PublicEnvTracker {
  return { referencedKeys: new Set(), declaredEnv: {} };
}

interface Violation {
  line: number;
  expression: string;
  cause: string;
  fix: string;
}

/**
 * Walks a module's AST looking for `process.env.*` and `import.meta.env.*`
 * reads and returns the first violation found, or `undefined` if the module
 * is clean. Only the first violation is reported per module, fail-fast, so a
 * build failure always points at one concrete fix.
 *
 * `onPublicKeyRead` fires for every statically-resolved `PUBLIC_*` key
 * allowed through, so the caller can track which declared `PUBLIC_*` env
 * vars are actually referenced anywhere in the client build (see
 * `gateBSecrets`'s `generateBundle` check below).
 *
 * `consumedEnvBases` tracks every `import.meta.env`
 * MemberExpression node that was already judged as the `.object` of a
 * further static/computed `.KEY` access (the two checks above) — i.e. a
 * NARROWED read, whether allowed or refused. Because `walk` visits a parent
 * node before its children, an outer `<base>.KEY` access always marks its
 * `base` sub-node as consumed BEFORE that same sub-node is visited on its
 * own. Any `import.meta.env` MemberExpression NOT found in this set when
 * visited on its own is therefore a bare reference used as a value —
 * `const env = import.meta.env`, `fn(import.meta.env)`,
 * `fn({...import.meta.env})`, `const { X } = import.meta.env` all take this
 * exact shape (the base is a direct child of a declarator/argument/spread,
 * never wrapped in one more `.KEY` MemberExpression) — and leaks the WHOLE
 * env object, not one key, so it fails regardless of what it's assigned to.
 */
function findViolation(
  code: string,
  ast: any,
  onPublicKeyRead: (key: string) => void,
): Violation | undefined {
  let found: Violation | undefined;
  const consumedEnvBases = new WeakSet<object>();

  walk(ast.program, (node) => {
    if (found || node.type !== "MemberExpression") return;
    const outer = node;

    if (isProcessEnvBase(outer.object)) {
      const key = resolveKey(outer);
      found = {
        line: outer.loc.start.line,
        expression: expressionText(code, outer),
        cause: key.static
          ? `"process.env.${key.key}" is read in client-bound code. process.env does not exist in the browser — there is no "public" process.env key, static or computed.`
          : `a computed key is read off process.env in client-bound code. process.env does not exist in the browser, and the compiler cannot guess whether a computed key is safe.`,
        fix: `Move the code that needs this value into a *.server.ts file or a server export (loader/route/middleware/validation/metadata), or — if the client genuinely needs this value — expose it via import.meta.env.${PUBLIC_ENV_PREFIX}* instead.`,
      };
      return;
    }

    if (isImportMetaEnvBase(outer.object)) {
      consumedEnvBases.add(outer.object);
      const key = resolveKey(outer);
      if (key.static && VITE_BUILTIN_ENV_KEYS.has(key.key)) return; // Vite built-in, not a secret
      if (key.static && key.key.startsWith(PUBLIC_ENV_PREFIX)) {
        onPublicKeyRead(key.key);
        return; // allowed
      }

      found = {
        line: outer.loc.start.line,
        expression: expressionText(code, outer),
        cause: key.static
          ? `"import.meta.env.${key.key}" is read in client-bound code, but its name does not start with "${PUBLIC_ENV_PREFIX}". Only import.meta.env keys prefixed "${PUBLIC_ENV_PREFIX}" are allowed in the client build — everything else is assumed to be a secret.`
          : `a computed key is read off import.meta.env in client-bound code. The compiler cannot guess whether a computed key resolves to a "${PUBLIC_ENV_PREFIX}"-prefixed name, so it fails closed rather than assume the key is public.`,
        fix: key.static
          ? `Rename the env var to start with "${PUBLIC_ENV_PREFIX}" (e.g. "${PUBLIC_ENV_PREFIX}${key.key}") if it is genuinely safe to ship to the browser, or move the code that reads it into a *.server.ts file / server export otherwise.`
          : `Use a static "import.meta.env.${PUBLIC_ENV_PREFIX}*" literal key instead of a computed one, or move the code that reads it into a *.server.ts file / server export if the key resolves to a secret.`,
      };
      return;
    }

    if (isImportMetaEnvBase(outer) && !consumedEnvBases.has(outer)) {
      found = {
        line: outer.loc.start.line,
        expression: expressionText(code, outer),
        cause: `"import.meta.env" is referenced as a whole object in client-bound code (not narrowed to one static "${PUBLIC_ENV_PREFIX}*" key access) — used as a value like this (assigned, destructured, spread, or passed as an argument), it leaks every declared env var, public or not, to the client.`,
        fix: `Read only the specific "import.meta.env.${PUBLIC_ENV_PREFIX}*" key(s) you actually need, one at a time, instead of referencing the whole "import.meta.env" object.`,
      };
    }
  });

  return found;
}

/**
 * The client-build Vite plugin. `vite` is only imported for its types
 * (`import type`), matching Gate A / projection's peer-dependency shape.
 *
 * Beyond the `transform` gate itself, this plugin also owns two pieces of
 * Vite config surface, both load-bearing for
 * the `PUBLIC_` convention this file defines:
 *
 * 1. `config()` sets `envPrefix: "PUBLIC_"`. Vite's own `import.meta.env.*`
 *    inlining (its `vite:define` plugin) only loads env vars from
 *    `process.env`/`.env` files that match `envPrefix`, which defaults to
 *    `"VITE_"` — NOT `"PUBLIC_"`. Verified against a real build: without this
 *    line, `import.meta.env.PUBLIC_API_URL` silently compiles to `void 0` in
 *    the emitted bundle (Vite's own definePlugin doesn't know the var
 *    exists, so it replaces the read with its "undefined" fallback), even
 *    though Gate B's `transform` gate allows the read through. This is not
 *    just an optimization — without it, every `PUBLIC_*` read Gate B
 *    approves is a silent runtime bug.
 * 2. `configResolved`/`generateBundle` track which declared `PUBLIC_*` keys
 *    were actually read (via `findViolation`'s `onPublicKeyRead` callback)
 *    and, once the bundle is emitted, scan the real output for any
 *    unread key's value leaking in anyway (e.g. via `{...import.meta.env}`
 *    or another whole-object read, which Vite serializes in full,
 *    independent of Gate B's own per-key checks) — verified on the actual
 *    emitted chunk code, not assumed from the transform/define config alone.
 *
 * `options.tracker` (default: a private, unshared one) is where that
 * read/declared-env state lives — pass the SAME `PublicEnvTracker` instance
 * used to build Gate C's inlined-value manifest (`warlockClientBoundary`
 * does this) so the manifest and this plugin's unread-key exclusion read off
 * one shared Set, not two.
 */
export function gateBSecrets(gateBOptions: { tracker?: PublicEnvTracker } = {}): Plugin {
  const tracker = gateBOptions.tracker ?? createPublicEnvTracker();

  return {
    name: "warlock:gate-b-secrets",
    enforce: "pre",
    config() {
      return { envPrefix: PUBLIC_ENV_PREFIX };
    },
    configResolved(config) {
      tracker.declaredEnv = config.env;
    },
    transform(code, id, options) {
      if (options?.ssr) return null;
      if (!isJsModule(id)) return null;
      if (isNodeModulesFile(id)) return null;

      const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });

      const violation = findViolation(code, ast, (key) => tracker.referencedKeys.add(key));
      if (violation) {
        this.error(
          [
            `Gate B refused a module: forbidden inline env read in the client build.`,
            ``,
            `File: ${id}:${violation.line}`,
            `Expression: ${violation.expression}`,
            `Cause: ${violation.cause}`,
            `Fix: ${violation.fix}`,
          ].join("\n"),
        );
      }

      return null;
    },
    generateBundle(_options, bundle) {
      if (this.environment?.config?.consumer === "server") return;

      const unreadKeys = Object.keys(tracker.declaredEnv).filter(
        (key) => key.startsWith(PUBLIC_ENV_PREFIX) && !tracker.referencedKeys.has(key),
      );
      if (unreadKeys.length === 0) return;

      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;

        for (const key of unreadKeys) {
          const inlinedValue = JSON.stringify(tracker.declaredEnv[key]);
          if (!file.code.includes(inlinedValue)) continue;

          this.error(
            [
              `Gate B refused a build: an unread PUBLIC_ env var was inlined into the emitted bundle.`,
              ``,
              `File: ${file.fileName}`,
              `Key: import.meta.env.${key}`,
              `Cause: "${key}" is never read as "import.meta.env.${key}" anywhere in the client build, but its value was still inlined into the emitted output — most likely a whole-object "import.meta.env" read (e.g. a spread or destructure), which Vite serializes in full regardless of which individual keys are actually used.`,
              `Fix: read "import.meta.env.${key}" directly wherever its value is needed instead of spreading/destructuring the whole "import.meta.env" object, or remove the unused "${key}" declaration if the client build doesn't need it.`,
            ].join("\n"),
          );
        }
      }
    },
  };
}
