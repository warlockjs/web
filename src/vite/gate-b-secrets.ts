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
 * in the browser, so any static or computed read of `process.env.X`, or of
 * `process.env` itself as a bare whole-object value (destructured, spread,
 * assigned, or passed as an argument), is forbidden regardless of `X`.
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
 *
 * A bare `process.env` reference is caught the same way, for the same
 * reason — `findViolation`'s `consumedEnvBases` check applies to both bases,
 * and unlike `import.meta.env` there is no allowed key at all for
 * `process.env`, narrowed or bare.
 */
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Plugin } from "vite";

/** A generic AST node, opaque field values — this file's own walkers dispatch on `.type`. */
type AnyNode = t.Node;
type MaybeNode = AnyNode | null | undefined;

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
 * Field names that only ever hold TYPE-space nodes (annotations, generic
 * parameters/arguments). Both the scope collector and the violation walker
 * skip these entirely — a reference to `process` that appears only in a
 * type position (e.g. `function f(env: typeof process.env)`) is erased at
 * compile time and is never a runtime read, so it is one of the required
 * innocent cases and must never be visited as a candidate.
 */
const TYPE_ONLY_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeParameters",
]);

const SKIPPED_WALK_KEYS = new Set([
  "type",
  "start",
  "end",
  "loc",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "extra",
  ...TYPE_ONLY_KEYS,
]);

function isIdentifierNamed(node: MaybeNode, name: string): boolean {
  return t.isIdentifier(node) && node.name === name;
}

function isMemberExpression(
  node: MaybeNode,
): node is t.MemberExpression | t.OptionalMemberExpression {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

function isGlobalObjectLiteral(node: MaybeNode): boolean {
  return (
    isIdentifierNamed(node, "globalThis") ||
    isIdentifierNamed(node, "window") ||
    isIdentifierNamed(node, "self")
  );
}

/**
 * Binding names a pattern introduces (the LEFT side of a destructure/param —
 * never a value-reference). Used both to seed a scope's declared-names set
 * and to mark those same identifier nodes as excluded from the "is this a
 * `process` reference" check, since a binding site names a variable, it
 * doesn't read one.
 */
function collectPatternIdentifiers(pattern: MaybeNode, sink: (identifier: AnyNode) => void): void {
  if (!pattern) return;
  if (t.isIdentifier(pattern)) {
    sink(pattern);
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        collectPatternIdentifiers(prop.argument, sink);
      } else {
        if (!prop.computed && prop.key) sink(prop.key);
        collectPatternIdentifiers(prop.value, sink);
      }
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element) collectPatternIdentifiers(element, sink);
    }
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    // Only the LEFT side is a binding; `.right` is a real value expression
    // (a default value) and must stay visitable.
    collectPatternIdentifiers(pattern.left, sink);
    return;
  }
  if (t.isRestElement(pattern)) {
    collectPatternIdentifiers(pattern.argument, sink);
  }
}

/**
 * A single lexical scope's worth of state, keyed by identifier NAME (not
 * node identity — a name can be referenced anywhere inside the scope it was
 * declared in, including in nested functions that close over it, which is
 * exactly real JS scoping).
 */
interface Scope {
  readonly declaredNames: Set<string>;
  readonly globalAliasNames: Set<string>;
}

const FUNCTION_SCOPE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/**
 * Populates `declaredNames` (every binding introduced directly in this
 * scope — var/let/const, function/class names, import specifiers) and
 * `globalAliasNames` (names assigned directly from `globalThis`/`window`/
 * `self`, or from an already-known alias, in source order) by scanning a
 * scope's own statements. Never descends into a NESTED function/class body
 * — that is a separate scope, built separately when the walker reaches it —
 * but DOES record that nested function/class's own declared name, since the
 * name itself is bound in the enclosing scope.
 */
function collectScope(node: unknown, scope: Scope): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectScope(item, scope);
    return;
  }
  const candidate = node as AnyNode;
  if (typeof candidate.type !== "string") return;

  const addName = (identifier: AnyNode) =>
    scope.declaredNames.add((identifier as t.Identifier).name);

  if (t.isVariableDeclarator(candidate)) {
    collectPatternIdentifiers(candidate.id, addName);
    if (t.isIdentifier(candidate.id) && candidate.init) {
      const initIsAlias =
        isGlobalObjectLiteral(candidate.init) ||
        (t.isIdentifier(candidate.init) && scope.globalAliasNames.has(candidate.init.name));
      if (initIsAlias) scope.globalAliasNames.add(candidate.id.name);
    }
    collectScope(candidate.init, scope);
    return;
  }

  if (
    t.isFunctionDeclaration(candidate) ||
    t.isClassDeclaration(candidate) ||
    t.isClassExpression(candidate)
  ) {
    if (candidate.id?.name) scope.declaredNames.add(candidate.id.name);
    return; // params/body (or class body) are a separate scope — don't descend
  }

  if (FUNCTION_SCOPE_TYPES.has(candidate.type)) {
    return; // separate scope, built when the walker reaches this node
  }

  if (t.isImportDeclaration(candidate)) {
    for (const specifier of candidate.specifiers) {
      if (specifier.local?.name) scope.declaredNames.add(specifier.local.name);
    }
    return;
  }

  if (t.isCatchClause(candidate)) {
    if (candidate.param) {
      collectPatternIdentifiers(candidate.param, addName);
    }
    collectScope(candidate.body, scope);
    return;
  }

  const record = candidate as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SKIPPED_WALK_KEYS.has(key)) continue;
    collectScope(record[key], scope);
  }
}

/** Builds a function/program scope from its parameters and body. */
function buildScope(paramNodes: readonly AnyNode[], bodyNode: unknown): Scope {
  const scope: Scope = { declaredNames: new Set(), globalAliasNames: new Set() };
  for (const param of paramNodes) {
    collectPatternIdentifiers(param, (identifier) =>
      scope.declaredNames.add((identifier as t.Identifier).name),
    );
  }
  collectScope(bodyNode, scope);
  return scope;
}

/**
 * Identifier nodes that name a BINDING SITE, a non-computed property/member
 * KEY, or a statement LABEL rather than reading a variable's value — e.g.
 * the `process` in `function f(process) {}`, in `{ process: 1 }`, or in
 * `obj.process`. None of these are a reference to the `process` binding, so
 * they must never trip the bare-identifier check. Built once per module via
 * a dedicated pass (mirrors `consumedEnvBases`'s "mark, then check identity"
 * shape) rather than re-derived from parent context during the main walk,
 * so the exclusion logic lives in exactly one place.
 */
function collectExcludedIdentifiers(root: unknown): WeakSet<object> {
  const excluded = new WeakSet<object>();
  const exclude = (identifier: MaybeNode): void => {
    if (identifier) excluded.add(identifier);
  };

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const candidate = node as AnyNode;
    if (typeof candidate.type !== "string") return;

    if (t.isVariableDeclarator(candidate)) {
      collectPatternIdentifiers(candidate.id, exclude);
    } else if (t.isFunctionDeclaration(candidate) || t.isFunctionExpression(candidate)) {
      exclude(candidate.id);
      for (const param of candidate.params) collectPatternIdentifiers(param, exclude);
    } else if (t.isArrowFunctionExpression(candidate)) {
      for (const param of candidate.params) collectPatternIdentifiers(param, exclude);
    } else if (t.isClassDeclaration(candidate) || t.isClassExpression(candidate)) {
      exclude(candidate.id);
    } else if (t.isImportSpecifier(candidate)) {
      exclude(candidate.local);
      exclude(candidate.imported);
    } else if (t.isImportDefaultSpecifier(candidate) || t.isImportNamespaceSpecifier(candidate)) {
      exclude(candidate.local);
    } else if (t.isClassPrivateProperty(candidate)) {
      exclude(candidate.key);
    } else if (t.isObjectProperty(candidate) || t.isClassProperty(candidate)) {
      if (!candidate.computed) exclude(candidate.key);
    } else if (
      t.isObjectMethod(candidate) ||
      t.isClassMethod(candidate) ||
      t.isClassPrivateMethod(candidate)
    ) {
      if (!candidate.computed) exclude(candidate.key);
      for (const param of candidate.params) collectPatternIdentifiers(param, exclude);
    } else if (t.isCatchClause(candidate)) {
      collectPatternIdentifiers(candidate.param, exclude);
    } else if (
      t.isLabeledStatement(candidate) ||
      t.isBreakStatement(candidate) ||
      t.isContinueStatement(candidate)
    ) {
      exclude(candidate.label);
    } else if (isMemberExpression(candidate)) {
      if (!candidate.computed) exclude(candidate.property);
    }

    const record = candidate as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (SKIPPED_WALK_KEYS.has(key)) continue;
      visit(record[key]);
    }
  };

  visit(root);
  return excluded;
}

/**
 * Matches an obtainable reference to Node's `process` object: the bare
 * `process` identifier (only when NOT shadowed by a local declaration
 * anywhere in the enclosing scope chain — the required innocent case), or a
 * `.process` / `["process"]` member access on `globalThis`/`window`/`self`
 * OR a variable known (via `scopeStack`'s `globalAliasNames`) to alias one
 * of them. `scopeStack` is ordered innermost-first; a name declared/aliased
 * in ANY enclosing scope counts, matching real lexical scoping (a nested
 * function sees an outer `const process = ...` or `const g = globalThis`
 * too).
 */
function isProcessObject(node: MaybeNode, scopeStack: readonly Scope[]): boolean {
  if (isIdentifierNamed(node, "process")) {
    return !scopeStack.some((scope) => scope.declaredNames.has("process"));
  }
  if (!isMemberExpression(node)) return false;

  const host = node.object;
  const hostIsAlias =
    t.isIdentifier(host) && scopeStack.some((scope) => scope.globalAliasNames.has(host.name));
  if (!isGlobalObjectLiteral(host) && !hostIsAlias) return false;

  if (!node.computed) return isIdentifierNamed(node.property, "process");
  return t.isStringLiteral(node.property) && node.property.value === "process";
}

/** Matches the `process.env` member expression itself (dot or static-bracket). */
function isProcessEnvBase(node: MaybeNode, scopeStack: readonly Scope[]): boolean {
  if (!isMemberExpression(node)) return false;
  if (!isProcessObject(node.object, scopeStack)) return false;
  if (!node.computed) return isIdentifierNamed(node.property, "env");
  return t.isStringLiteral(node.property) && node.property.value === "env";
}

/** Matches the `import.meta.env` member expression itself (dot or static-bracket). */
function isImportMetaEnvBase(node: MaybeNode): boolean {
  if (!isMemberExpression(node)) return false;
  const object = node.object;
  if (!t.isMetaProperty(object)) return false;
  if (object.meta.name !== "import" || object.property.name !== "meta") return false;
  if (!node.computed) return isIdentifierNamed(node.property, "env");
  return t.isStringLiteral(node.property) && node.property.value === "env";
}

type KeyResolution = { readonly static: true; readonly key: string } | { readonly static: false };

/**
 * Resolves the key an outer `<base>.<key>` / `<base>[<key>]` member
 * expression reads off `process.env` or `import.meta.env`. Only a literal
 * dot-property or a static string-literal bracket key counts as static —
 * anything else (a variable, a template literal, a call expression, ...) is
 * a computed key and must fail closed rather than guessed at.
 */
function resolveKey(outer: t.MemberExpression | t.OptionalMemberExpression): KeyResolution {
  if (!outer.computed) {
    if (t.isIdentifier(outer.property)) return { static: true, key: outer.property.name };
    return { static: false };
  }
  if (t.isStringLiteral(outer.property)) return { static: true, key: outer.property.value };
  return { static: false };
}

function expressionText(code: string, node: AnyNode): string {
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
 * reads — narrowed member accesses and bare whole-object references alike —
 * and returns the first violation found, or `undefined` if the module is
 * clean. Only the first violation is reported per module, fail-fast, so a
 * build failure always points at one concrete fix.
 *
 * `onPublicKeyRead` fires for every statically-resolved `PUBLIC_*` key
 * allowed through, so the caller can track which declared `PUBLIC_*` env
 * vars are actually referenced anywhere in the client build (see
 * `gateBSecrets`'s `generateBundle` check below).
 *
 * `consumedEnvBases` tracks every `process.env` and `import.meta.env`
 * MemberExpression node that was already judged as the `.object` of a
 * further static/computed `.KEY` access (the narrowed-read checks above) —
 * i.e. a NARROWED read, whether allowed or refused. Because `walk` visits a
 * parent node before its children, an outer `<base>.KEY` access always marks
 * its `base` sub-node as consumed BEFORE that same sub-node is visited on
 * its own. Any `process.env` or `import.meta.env` MemberExpression NOT found
 * in this set when visited on its own is therefore a bare reference used as
 * a value — `const env = process.env`, `fn(process.env)`,
 * `fn({...process.env})`, `const { X } = process.env` (and the same four
 * shapes for `import.meta.env`) all take this exact shape (the base is a
 * direct child of a declarator/argument/spread, never wrapped in one more
 * `.KEY` MemberExpression) — and leaks the WHOLE env object, not one key, so
 * it fails regardless of what it's assigned to.
 */
/**
 * Refuses ANY reference to the `process` binding when it is not locally
 * declared — not only its `.env` narrowing. Once a reference to `process`
 * is obtainable at all (bare, or via `.process`/`["process"]` on
 * `globalThis`/`window`/`self`/an alias of one), what happens to it
 * afterward can't be tracked by an AST-only gate, so the reference itself
 * is the violation, exactly like `import.meta.env`'s bare-whole-object
 * check just above it.
 */
function processReferenceViolation(node: AnyNode, code: string): Violation {
  const expression = expressionText(code, node);
  return {
    line: node.loc!.start.line,
    expression,
    cause: `"${expression}" obtains Node's "process" object (directly, or via globalThis/window/self or an alias of one) in client-bound code. process does not exist in the browser, and once a reference to it escapes into a variable its later use can't be tracked statically — so the reference itself is refused, not only a ".env" read off it.`,
    fix: `Move the code that needs this value into a *.server.ts file or a server export (loader/route/middleware/validation/metadata), or — if the client genuinely needs a value — expose it via import.meta.env.${PUBLIC_ENV_PREFIX}* instead.`,
  };
}

function findViolation(
  code: string,
  ast: t.File,
  onPublicKeyRead: (key: string) => void,
): Violation | undefined {
  let found: Violation | undefined;
  const consumedEnvBases = new WeakSet<object>();
  const excludedIdentifiers = collectExcludedIdentifiers(ast.program);
  const scopeStack: Scope[] = [buildScope([], ast.program.body)];

  function checkNode(node: AnyNode): void {
    if (isMemberExpression(node)) {
      const outer = node;

      if (isProcessEnvBase(outer.object, scopeStack)) {
        consumedEnvBases.add(outer.object);
        const key = resolveKey(outer);
        found = {
          line: outer.loc!.start.line,
          expression: expressionText(code, outer),
          cause: key.static
            ? `"process.env.${key.key}" is read in client-bound code. process.env does not exist in the browser — there is no "public" process.env key, static or computed.`
            : `a computed key is read off process.env in client-bound code. process.env does not exist in the browser, and the compiler cannot guess whether a computed key is safe.`,
          fix: `Move the code that needs this value into a *.server.ts file or a server export (loader/route/middleware/validation/metadata), or — if the client genuinely needs this value — expose it via import.meta.env.${PUBLIC_ENV_PREFIX}* instead.`,
        };
        return;
      }

      if (isProcessEnvBase(outer, scopeStack) && !consumedEnvBases.has(outer)) {
        found = {
          line: outer.loc!.start.line,
          expression: expressionText(code, outer),
          cause: `"process.env" is referenced as a whole object in client-bound code (not narrowed to one static "process.env.<KEY>" access) — process.env does not exist in the browser, so reading it as a value like this (assigned, destructured, spread, or passed as an argument) is never safe: there is no "public" process.env key, static or computed.`,
          fix: `Move the code that needs this value into a *.server.ts file or a server export (loader/route/middleware/validation/metadata), reading only the specific "process.env.<KEY>" value you actually need, or — if the client genuinely needs a value — expose it via import.meta.env.${PUBLIC_ENV_PREFIX}* instead.`,
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
          line: outer.loc!.start.line,
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
          line: outer.loc!.start.line,
          expression: expressionText(code, outer),
          cause: `"import.meta.env" is referenced as a whole object in client-bound code (not narrowed to one static "${PUBLIC_ENV_PREFIX}*" key access) — used as a value like this (assigned, destructured, spread, or passed as an argument), it leaks every declared env var, public or not, to the client.`,
          fix: `Read only the specific "import.meta.env.${PUBLIC_ENV_PREFIX}*" key(s) you actually need, one at a time, instead of referencing the whole "import.meta.env" object.`,
        };
        return;
      }

      // Not narrowed to `.env` (or already consumed above) — but if this
      // member expression IS `<global-or-alias>.process` / `["process"]`,
      // it obtains the process object on its own and must be refused at
      // this exact point, independent of whether `.env` is ever read off it
      // (e.g. `const p = globalThis.process;`, `const p = window.process;`).
      if (isProcessObject(outer, scopeStack)) {
        found = processReferenceViolation(outer, code);
      }
      return;
    }

    if (isIdentifierNamed(node, "process") && !excludedIdentifiers.has(node)) {
      if (!scopeStack.some((scope) => scope.declaredNames.has("process"))) {
        found = processReferenceViolation(node, code);
      }
    }
  }

  function traverse(node: unknown): void {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        traverse(item);
        if (found) return;
      }
      return;
    }
    const candidate = node as AnyNode;
    if (typeof candidate.type !== "string") return;

    const isFunctionScope = FUNCTION_SCOPE_TYPES.has(candidate.type);
    if (isFunctionScope) {
      const fn = candidate as t.Function;
      scopeStack.push(buildScope(fn.params, fn.body));
    }

    checkNode(candidate);

    if (!found) {
      const record = candidate as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (SKIPPED_WALK_KEYS.has(key)) continue;
        traverse(record[key]);
        if (found) break;
      }
    }

    if (isFunctionScope) scopeStack.pop();
  }

  traverse(ast.program);

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

      let ast: t.File | null = null;
      try {
        ast = parse(code, {
          sourceType: "module",
          // `decorators-legacy` matches how the rest of the client pipeline
          // parses TS (`build/generate-pages-barrel.ts`) — a server module
          // that leaks into the client graph (e.g. a `@warlock.js/cascade`
          // decorated model reached through an unstripped page export) must
          // be judged by THIS gate's own boundary/secrets rule, not crash the
          // parser before the gate ever runs.
          plugins: ["typescript", "jsx", "decorators-legacy"],
        });
      } catch (error) {
        this.error(
          [
            `Gate B could not parse a module reached from the client graph.`,
            ``,
            `File: ${id}`,
            `Cause: ${(error as Error).message}`,
            `Fix: this file was pulled into the client build by an import chain from a page/layout/root module — if it is server-only code, keep it behind a server export (route/middleware/validation/loader/metadata/prefix/sitemap) or a *.server.ts boundary so it is never reached from the client graph; otherwise fix its syntax.`,
          ].join("\n"),
        );
      }
      if (!ast) return null;

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
