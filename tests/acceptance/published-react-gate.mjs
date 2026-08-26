#!/usr/bin/env node

/**
 * Published-install React browser acceptance gate.
 *
 * Usage (from the repository root):
 *
 *   node web/tests/acceptance/published-react-gate.mjs --full-family
 *   node web/tests/acceptance/published-react-gate.mjs --red-control
 *   node web/tests/acceptance/published-react-gate.mjs --web-version 5.0.3
 *   node web/tests/acceptance/published-react-gate.mjs --web-version 5.0.3 --registry-peer-version 5.0.2
 *
 * The browser driver is intentionally resolved from this checkout. The app
 * under test is not: it is created below the OS temp directory and every
 * @warlock.js package is installed from a local packed artifact or the HTTPS
 * npm registry. Workspace packages are never linked. The explicit
 * --registry-peer-version mode isolates a web fix against released core/seal;
 * --full-family remains the release-family gate.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const gateFile = fileURLToPath(import.meta.url);
const gateDir = path.dirname(gateFile);
const workspaceRoot = path.resolve(gateDir, "../../..");
const defaultArtifactRoot = path.join(workspaceRoot, "builder", "builds", "@warlock.js");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Published React gate

Options:
  --red-control          Remove React optimizeDeps.include in a copied web artifact.
  --web-version X.Y.Z    Test this pkgist artifact version (default: newest web build).
  --artifact-root PATH   Root containing <package>/<version>/ pkgist builds.
  --registry-peer-version X.Y.Z
                         Fix-isolation mode: pack only web and install exact
                         core/seal X.Y.Z from the HTTPS npm registry.
  --full-family          Pack and install the complete same-version Warlock family.
  --keep-temp            Preserve the external app and tarballs for inspection.
  --help                 Print this help.

Both full-family and fix-isolation modes use the same browser assertions.
Red-control is expected to print EXIT FAIL and return a nonzero status.`);
  process.exit(0);
}

const installationMode = args.registryPeerVersion ? "fix-isolation" : "full-family";
const mode = args.redControl ? `${installationMode}-red-control` : installationMode;
const artifactRoot = path.resolve(args.artifactRoot ?? defaultArtifactRoot);
const state = {
  tempRoot: undefined,
  appRoot: undefined,
  server: undefined,
  serverOutput: [],
};

let report;
try {
  report = await runGate();
} catch (error) {
  report = {
    mode,
    measured: {},
    assertions: [
      {
        name: "gate completed",
        pass: false,
        detail: formatError(error),
      },
    ],
    setupError: formatError(error),
  };
} finally {
  await stopServer();
}

let passed = report.assertions.every(assertion => assertion.pass);
console.log("MEASURED " + JSON.stringify(report, null, 2));

if (!passed && state.serverOutput.length > 0) {
  console.log("SERVER_TAIL_BEGIN");
  console.log(state.serverOutput.slice(-80).join("\n"));
  console.log("SERVER_TAIL_END");
}

if (args.keepTemp && state.tempRoot) {
  console.log(`TEMP kept=${state.tempRoot}`);
} else if (state.tempRoot) {
  try {
    await fs.rm(state.tempRoot, { recursive: true, force: true });
    console.log(`TEMP removed=${state.tempRoot}`);
  } catch (error) {
    passed = false;
    console.log(`TEMP cleanup-failed=${state.tempRoot} error=${formatError(error)}`);
  }
}

console.log(`EXIT ${passed ? "PASS" : "FAIL"} code=${passed ? 0 : 1} mode=${mode}`);
process.exitCode = passed ? 0 : 1;

async function runGate() {
  const webVersion = args.webVersion ?? (await newestArtifactVersion("web"));
  const originalWebArtifact = path.join(artifactRoot, "web", webVersion);
  await assertArtifact(originalWebArtifact, "@warlock.js/web", webVersion);

  state.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warlock-published-react-gate-"));
  state.appRoot = path.join(state.tempRoot, "app");
  const packRoot = path.join(state.tempRoot, "packed");
  await fs.mkdir(state.appRoot, { recursive: true });
  await fs.mkdir(packRoot, { recursive: true });

  assertOutsideWorkspace(state.tempRoot);

  let webArtifact = originalWebArtifact;
  let redMutation;
  if (args.redControl) {
    webArtifact = path.join(state.tempRoot, "red-artifact", "web");
    await fs.cp(originalWebArtifact, webArtifact, { recursive: true });
    redMutation = await breakReactOptimization(webArtifact);
    console.log(
      `RED_CONTROL artifact=${redMutation.file}:${redMutation.line} mutation=${JSON.stringify(redMutation.text)}`,
    );
  }

  const closure = await collectPackedClosure(webVersion, webArtifact, installationMode);
  const tarballs = new Map();
  const packedEvidence = [];

  for (const artifact of closure) {
    const tarball = await npmPack(artifact.root, packRoot);
    const identityEvidence = await sourceEvidence(
      path.join(artifact.root, "package.json"),
      `"name": "${artifact.name}"`,
      `${artifact.name}@${artifact.version} artifact identity`,
    );
    tarballs.set(artifact.name, tarball);
    packedEvidence.push({
      package: artifact.name,
      version: artifact.version,
      artifact: artifact.root,
      tarball,
      sha256: await sha256(tarball),
      source: `${identityEvidence.file}:${identityEvidence.line}`,
    });
  }

  const port = await reserveEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fixtureEvidence = await writeFixture(state.appRoot, baseUrl, tarballs, args.registryPeerVersion);

  console.log(`MODE ${mode}`);
  console.log(
    `INSTALL_MODE ${installationMode}${args.registryPeerVersion ? ` registry-peer-version=${args.registryPeerVersion}` : ""}`,
  );
  console.log(`NODE_ENV explicit=development asserted=true`);
  console.log(`APP external=${state.appRoot} workspace=${workspaceRoot}`);
  for (const item of packedEvidence) {
    console.log(
      `PACKED package=${item.package}@${item.version} source=${item.source} tarball=${item.tarball} sha256=${item.sha256}`,
    );
  }
  for (const evidence of fixtureEvidence) {
    console.log(`SOURCE ${evidence.file}:${evidence.line} ${evidence.label}`);
  }

  await runNpm(["install", "--prefer-online", "--no-audit", "--no-fund", "--legacy-peer-deps"], {
    cwd: state.appRoot,
    env: explicitDevelopmentEnv(),
    timeoutMs: 10 * 60_000,
    label: "npm install packed artifacts",
  });

  const installEvidence = await verifyPublishedInstall({
    packedArtifacts: closure,
    registryPeerVersion: args.registryPeerVersion,
    appRoot: state.appRoot,
  });
  for (const evidence of installEvidence) {
    console.log(
      `INSTALLED package=${evidence.package}@${evidence.version} path=${evidence.path}${path.sep}package.json:1 symlink=${evidence.symlink} source=${evidence.source} resolution=${evidence.resolution}`,
    );
  }

  const installedConnector = path.join(
    state.appRoot,
    "node_modules",
    "@warlock.js",
    "web",
    "esm",
    "server",
    "web-connector.mjs",
  );
  const optimizerEvidence = await sourceEvidence(installedConnector, "optimizeDeps:", "installed optimizeDeps seam");
  const includeEvidence = await optionalSourceEvidence(
    installedConnector,
    "include: [",
    "installed React optimizer include",
  );
  console.log(`ARTIFACT ${optimizerEvidence.file}:${optimizerEvidence.line} ${optimizerEvidence.label}`);
  if (includeEvidence) {
    console.log(`ARTIFACT ${includeEvidence.file}:${includeEvidence.line} ${includeEvidence.label}`);
  }

  const serverEnv = explicitDevelopmentEnv();
  if (serverEnv.NODE_ENV !== "development") {
    throw new Error(`NODE_ENV assertion failed before server spawn: ${JSON.stringify(serverEnv.NODE_ENV)}`);
  }

  const warlockBin = path.join(
    state.appRoot,
    "node_modules",
    "@warlock.js",
    "core",
    "bin",
    "warlock.js",
  );
  state.server = spawn(process.execPath, [warlockBin, "dev"], {
    cwd: state.appRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  captureServerOutput(state.server.stdout);
  captureServerOutput(state.server.stderr);

  await waitForServer(baseUrl, 90_000);
  const browserResults = await driveChromium(baseUrl, fixtureEvidence);

  const assertions = [
    assertion("temp app is outside monorepo", !isInside(workspaceRoot, state.appRoot), state.appRoot),
    assertion("NODE_ENV is explicitly development", serverEnv.NODE_ENV === "development", serverEnv.NODE_ENV),
    assertion(
      "all Warlock installs are extracted directories, never symlinks",
      installEvidence.every(item => !item.symlink),
      installEvidence.map(item => `${item.package}:${item.symlink}`).join(", "),
    ),
    assertion(
      args.registryPeerVersion
        ? "web is a non-symlink packed tarball and core/seal are non-symlink HTTPS registry resolutions"
        : "complete Warlock family resolves from non-symlink packed tarballs",
      args.registryPeerVersion
        ? installEvidence.some(item => item.package === "@warlock.js/web" && item.source === "packed-tarball") &&
            ["@warlock.js/core", "@warlock.js/seal"].every(packageName =>
              installEvidence.some(
                item =>
                  item.package === packageName &&
                  item.version === args.registryPeerVersion &&
                  item.source === "https-registry",
              ),
            )
        : installEvidence.every(item => item.source === "packed-tarball"),
      installEvidence.map(item => `${item.package}@${item.version}:${item.source}:${item.resolution}`).join(", "),
    ),
    assertion(
      "react-dom/client was served through Vite's ESM optimizer",
      browserResults.reactDomClientUrls.some(url => /\/node_modules\/\.vite\/deps\/react-dom_client(?:-|\.)/.test(url)),
      JSON.stringify(browserResults.reactDomClientUrls),
    ),
    assertion("React hydration effect runs", browserResults.hydrated, String(browserResults.hydrated)),
    assertion(
      "useState counter increments on two real clicks",
      browserResults.counter.before === "Clicked 0 times" && browserResults.counter.after === "Clicked 2 times",
      `${JSON.stringify(browserResults.counter.before)} -> ${JSON.stringify(browserResults.counter.after)}`,
    ),
    assertion(
      "JSX edit hot-updates DOM without document request or reload",
      browserResults.hmr.after === "HMR_MARKER_B" &&
        browserResults.hmr.documentRequests === 0 &&
        browserResults.hmr.realmSurvived,
      JSON.stringify(browserResults.hmr),
    ),
    assertion(
      "@warlock.js/web Link navigates client-side",
      browserResults.link.url === `${baseUrl}/about` &&
        browserResults.link.aboutText === "ABOUT_OK" &&
        browserResults.link.documentRequests === 0 &&
        browserResults.link.realmSurvived,
      JSON.stringify(browserResults.link),
    ),
    assertion(
      "browser console errors are empty",
      browserResults.consoleErrors.length === 0,
      JSON.stringify(browserResults.consoleErrors),
    ),
    assertion(
      "browser page errors are empty",
      browserResults.pageErrors.length === 0,
      JSON.stringify(browserResults.pageErrors),
    ),
  ];

  return {
    mode,
    installationMode,
    webVersion,
    registryPeerVersion: args.registryPeerVersion ?? null,
    tempApp: state.appRoot,
    nodeEnv: serverEnv.NODE_ENV,
    packedArtifacts: packedEvidence,
    artifactEvidence: {
      optimizeDeps: `${optimizerEvidence.file}:${optimizerEvidence.line}`,
      reactInclude: includeEvidence ? `${includeEvidence.file}:${includeEvidence.line}` : null,
      redMutation: redMutation ? `${redMutation.file}:${redMutation.line}` : null,
    },
    sourceEvidence: fixtureEvidence.map(item => `${item.file}:${item.line} ${item.label}`),
    measured: browserResults,
    assertions,
  };
}

function parseArgs(argv) {
  const parsed = {
    redControl: false,
    keepTemp: false,
    help: false,
    fullFamily: false,
    webVersion: undefined,
    artifactRoot: undefined,
    registryPeerVersion: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--red-control") parsed.redControl = true;
    else if (argument === "--keep-temp") parsed.keepTemp = true;
    else if (argument === "--full-family") parsed.fullFamily = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--web-version") parsed.webVersion = requiredValue(argv, ++index, argument);
    else if (argument === "--artifact-root") parsed.artifactRoot = requiredValue(argv, ++index, argument);
    else if (argument === "--registry-peer-version") {
      parsed.registryPeerVersion = requiredExactVersion(argv, ++index, argument);
    }
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}. Use --help.`);
  }

  if (parsed.fullFamily && parsed.registryPeerVersion) {
    throw new Error("--full-family and --registry-peer-version cannot be used together.");
  }

  return parsed;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function requiredExactVersion(argv, index, option) {
  const value = requiredValue(argv, index, option);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${option} requires an exact semver version, not ${JSON.stringify(value)}.`);
  }
  return value;
}

async function newestArtifactVersion(packageFolder) {
  const packageRoot = path.join(artifactRoot, packageFolder);
  const entries = await fs.readdir(packageRoot, { withFileTypes: true }).catch(() => []);
  const versions = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(compareVersions);
  if (versions.length === 0) {
    throw new Error(`No pkgist artifacts found below ${packageRoot}. Build the release family first.`);
  }
  return versions.at(-1);
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
  const b = right.split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (typeof a[index] === "number" && typeof b[index] === "number") return a[index] - b[index];
    return String(a[index]).localeCompare(String(b[index]));
  }
  return 0;
}

async function collectPackedClosure(version, webArtifact, installMode) {
  if (installMode === "fix-isolation") {
    const packageJson = await readJson(path.join(webArtifact, "package.json"));
    if (packageJson.name !== "@warlock.js/web" || packageJson.version !== version) {
      throw new Error(
        `Artifact identity mismatch at ${webArtifact}${path.sep}package.json: expected @warlock.js/web@${version}, ` +
          `found ${packageJson.name}@${packageJson.version}.`,
      );
    }
    return [{ name: "@warlock.js/web", version, root: webArtifact, packageJson }];
  }

  const pending = ["@warlock.js/web", "@warlock.js/core", "@warlock.js/seal"];
  const artifacts = new Map();

  while (pending.length > 0) {
    const name = pending.shift();
    if (artifacts.has(name)) continue;
    const folder = name.slice("@warlock.js/".length);
    const root = name === "@warlock.js/web" ? webArtifact : path.join(artifactRoot, folder, version);
    const packageJson = await readJson(path.join(root, "package.json")).catch(error => {
      throw new Error(
        `Missing same-version packed-install prerequisite ${name}@${version} at ${root}. ` +
          `Run pkgist for the complete family before this gate. ${formatError(error)}`,
      );
    });

    if (packageJson.name !== name || packageJson.version !== version) {
      throw new Error(
        `Artifact identity mismatch at ${root}${path.sep}package.json: expected ${name}@${version}, ` +
          `found ${packageJson.name}@${packageJson.version}.`,
      );
    }

    artifacts.set(name, { name, version, root, packageJson });
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      if (dependencyName.startsWith("@warlock.js/")) pending.push(dependencyName);
    }
  }

  return [...artifacts.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function assertArtifact(root, expectedName, expectedVersion) {
  const packageJson = await readJson(path.join(root, "package.json"));
  if (packageJson.name !== expectedName || packageJson.version !== expectedVersion) {
    throw new Error(
      `Expected ${expectedName}@${expectedVersion} at ${root}, found ${packageJson.name}@${packageJson.version}.`,
    );
  }
}

async function breakReactOptimization(webArtifact) {
  const connectorFile = path.join(webArtifact, "esm", "server", "web-connector.mjs");
  const original = await fs.readFile(connectorFile, "utf8");
  const seam = /include:\s*\[\s*["']react["']\s*,\s*["']react-dom["']\s*,\s*["']react-dom\/client["']\s*,\s*["']react\/jsx-runtime["']\s*\]/;
  const matches = original.match(new RegExp(seam.source, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Red control expected exactly one React optimizeDeps seam in ${connectorFile}, found ${matches.length}.`,
    );
  }

  const replacement = "include: []";
  const changed = original.replace(seam, replacement);
  await fs.writeFile(connectorFile, changed, "utf8");
  const evidence = await sourceEvidence(connectorFile, replacement, "React optimizer include deliberately emptied");
  return { ...evidence, text: replacement };
}

async function npmPack(artifact, destination) {
  const before = new Set(await fs.readdir(destination));
  await runNpm(["pack", artifact, "--pack-destination", destination, "--json"], {
    cwd: destination,
    env: explicitDevelopmentEnv(),
    timeoutMs: 2 * 60_000,
    label: `npm pack ${artifact}`,
  });
  const after = await fs.readdir(destination);
  const created = after.filter(file => file.endsWith(".tgz") && !before.has(file));
  if (created.length !== 1) {
    throw new Error(`npm pack ${artifact} produced ${created.length} new tarballs in ${destination}.`);
  }
  return path.join(destination, created[0]);
}

async function writeFixture(appRoot, baseUrl, tarballs, registryPeerVersion) {
  const dependencies = {
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.2.0",
    react: "19.2.3",
    "react-dom": "19.2.3",
    vite: "7.3.5",
  };
  for (const [name, tarball] of tarballs) dependencies[name] = `file:${toPosix(tarball)}`;
  if (registryPeerVersion) {
    dependencies["@warlock.js/core"] = registryPeerVersion;
    dependencies["@warlock.js/seal"] = registryPeerVersion;
  }

  const files = {
    "package.json": JSON.stringify(
      {
        name: "warlock-published-react-gate-app",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { dev: "warlock dev" },
        dependencies,
      },
      null,
      2,
    ),
    "warlock.config.ts": `import { defineConfig } from "@warlock.js/core";
import { webConnector } from "@warlock.js/web/connector";

export default defineConfig({ connectors: [webConnector()] });
`,
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          verbatimModuleSyntax: true,
          isolatedModules: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          baseUrl: "./src",
          paths: { "web/*": ["web/*"], "app/*": ["app/*"] },
        },
        include: ["src", "warlock.config.ts"],
        exclude: ["node_modules", "dist", ".warlock"],
      },
      null,
      2,
    ),
    "src/config/http.ts": `import type { HttpConfigurations } from "@warlock.js/core";

const http: HttpConfigurations = { port: ${new URL(baseUrl).port}, host: "127.0.0.1" };
export default http;
`,
    "src/config/app.ts": `import type { AppConfigurations } from "@warlock.js/core";

const app: AppConfigurations = {
  appName: "Published React Gate",
  baseUrl: ${JSON.stringify(baseUrl)},
  timezone: "UTC",
  localeCode: "en",
  localeCodes: ["en"],
};
export default app;
`,
    "src/web/root.tsx": `import type { AppProps } from "@warlock.js/web";
import { Head, Scripts } from "@warlock.js/web";

export default function App({ shared, children }: AppProps) {
  return <html lang={shared.locale} dir={shared.dir}><head><Head /></head><body><div id="root">{children}</div><Scripts /></body></html>;
}
`,
    "src/app/main/web/layout.tsx": `import type { LayoutProps } from "@warlock.js/web";
export const prefix = "/";
export default function Layout({ children }: LayoutProps) { return <main>{children}</main>; }
`,
    "src/app/main/web/counter.tsx": `import { useEffect, useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return <button id="counter" data-hydrated={hydrated} type="button" onClick={() => setCount(value => value + 1)}>Clicked {count} times</button>;
}
`,
    "src/app/main/web/home.page.tsx": `import { Link } from "@warlock.js/web";
import { Counter } from "./counter";

export const route = { path: "/", name: "main.home" } as const;

export default function HomePage() {
  return <><h1 id="hmr-marker">HMR_MARKER_A</h1><Counter /><Link href="/about">About</Link></>;
}
`,
    "src/app/main/web/about.page.tsx": `import { Link } from "@warlock.js/web";

export const route = { path: "/about", name: "main.about" } as const;

export default function AboutPage() {
  return <><h1 id="about-marker">ABOUT_OK</h1><Link href="/">Home</Link></>;
}
`,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(appRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents + (contents.endsWith("\n") ? "" : "\n"), "utf8");
  }

  return [
    await sourceEvidence(path.join(appRoot, "src/app/main/web/counter.tsx"), "useState(0)", "useState counter"),
    await sourceEvidence(path.join(appRoot, "src/app/main/web/counter.tsx"), "onClick=", "real click handler"),
    await sourceEvidence(path.join(appRoot, "src/app/main/web/home.page.tsx"), "HMR_MARKER_A", "JSX HMR edit target"),
    await sourceEvidence(path.join(appRoot, "src/app/main/web/home.page.tsx"), '<Link href="/about">', "@warlock.js/web Link"),
  ];
}

async function verifyPublishedInstall({ packedArtifacts, registryPeerVersion, appRoot }) {
  const lock = await readJson(path.join(appRoot, "package-lock.json"));
  const evidence = [];
  for (const artifact of packedArtifacts) {
    evidence.push(await verifyInstalledPackage({ ...artifact, source: "packed-tarball" }, appRoot, lock));
  }
  if (registryPeerVersion) {
    for (const name of ["@warlock.js/core", "@warlock.js/seal"]) {
      evidence.push(
        await verifyInstalledPackage(
          { name, version: registryPeerVersion, source: "https-registry" },
          appRoot,
          lock,
        ),
      );
    }
  }
  return evidence.sort((left, right) => left.package.localeCompare(right.package));
}

async function verifyInstalledPackage({ name, version, source }, appRoot, lock) {
  const installPath = path.join(appRoot, "node_modules", ...name.split("/"));
  const stat = await fs.lstat(installPath);
  const packageJson = await readJson(path.join(installPath, "package.json"));
  if (packageJson.name !== name || packageJson.version !== version) {
    throw new Error(
      `Installed identity mismatch at ${installPath}: expected ${name}@${version}, ` +
        `found ${packageJson.name}@${packageJson.version}.`,
    );
  }
  if (stat.isSymbolicLink()) throw new Error(`Published-install invariant failed: ${installPath} is a symlink.`);
  if (!isInside(appRoot, await fs.realpath(installPath))) {
    throw new Error(`Published-install invariant failed: ${installPath} resolves outside the temp app.`);
  }
  const lockKey = `node_modules/${name}`;
  const resolution = lock.packages?.[lockKey]?.resolved;
  const expectedResolutionPrefix = source === "packed-tarball" ? "file:" : "https://";
  if (!String(resolution ?? "").startsWith(expectedResolutionPrefix)) {
    throw new Error(
      `${source} resolution missing for ${name}: expected ${expectedResolutionPrefix}, ` +
        `found ${JSON.stringify(resolution)}.`,
    );
  }
  return {
    package: name,
    version,
    path: installPath,
    symlink: false,
    source,
    resolution,
  };
}

async function driveChromium(baseUrl, fixtureEvidence) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const documentRequests = [];
  const reactDomClientUrls = [];

  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("request", request => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
    if (/react-dom(?:%2F|\/|_).*client/i.test(request.url())) reactDomClientUrls.push(request.url());
  });

  const results = {
    hydrated: false,
    counter: { before: null, after: null },
    hmr: { before: null, after: null, documentRequests: null, realmSurvived: false },
    link: { url: null, aboutText: null, documentRequests: null, realmSurvived: false },
    consoleErrors,
    pageErrors,
    reactDomClientUrls,
    allDocumentRequests: documentRequests,
  };

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#counter").waitFor({ state: "visible", timeout: 15_000 });
    await page
      .locator('#counter[data-hydrated="true"]')
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => {
        results.hydrated = true;
      })
      .catch(() => undefined);

    results.counter.before = normalizeText(await page.locator("#counter").textContent());
    await page.locator("#counter").click();
    await page.locator("#counter").click();
    await page.waitForTimeout(250);
    results.counter.after = normalizeText(await page.locator("#counter").textContent());

    await page.evaluate(() => {
      window.__WARLOCK_HMR_REALM__ = "alive";
    });
    results.hmr.before = normalizeText(await page.locator("#hmr-marker").textContent());
    const documentsBeforeHmr = documentRequests.length;
    const homeSource = fixtureEvidence.find(item => item.label === "JSX HMR edit target").file;
    const originalHome = await fs.readFile(homeSource, "utf8");
    const editedHome = originalHome.replace("HMR_MARKER_A", "HMR_MARKER_B");
    if (editedHome === originalHome) throw new Error(`HMR edit target missing from ${homeSource}.`);
    await fs.writeFile(homeSource, editedHome, "utf8");
    try {
      await page.waitForFunction(
        () => document.querySelector("#hmr-marker")?.textContent?.trim() === "HMR_MARKER_B",
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      // Preserve the measured DOM and browser errors; the assertion below owns failure.
    }
    results.hmr.after = normalizeText(await page.locator("#hmr-marker").textContent().catch(() => null));
    results.hmr.documentRequests = documentRequests.length - documentsBeforeHmr;
    results.hmr.realmSurvived = await page.evaluate(() => window.__WARLOCK_HMR_REALM__ === "alive").catch(() => false);

    await page.evaluate(() => {
      window.__WARLOCK_LINK_REALM__ = "alive";
    });
    const documentsBeforeLink = documentRequests.length;
    await page.locator('a[href="/about"]').click();
    await page.waitForURL(`${baseUrl}/about`, { timeout: 15_000 }).catch(() => undefined);
    await page.locator("#about-marker").waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    results.link.url = page.url();
    results.link.aboutText = normalizeText(await page.locator("#about-marker").textContent().catch(() => null));
    results.link.documentRequests = documentRequests.length - documentsBeforeLink;
    results.link.realmSurvived = await page.evaluate(() => window.__WARLOCK_LINK_REALM__ === "alive").catch(() => false);
  } finally {
    await context.close();
    await browser.close();
  }

  return results;
}

function loadPlaywright() {
  const require = createRequire(path.join(workspaceRoot, "package.json"));
  for (const packageName of ["playwright", "playwright-core", "@playwright/test"]) {
    try {
      return require(packageName);
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(
    `Playwright is not installed in ${workspaceRoot}. Install the repository's declared web dev dependencies first.`,
  );
}

async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (state.server.exitCode !== null) {
      throw new Error(`warlock dev exited early with code ${state.server.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/`);
      const body = await response.text();
      if (response.ok && body.includes("HMR_MARKER_A")) return;
      lastError = new Error(`HTTP ${response.status}; marker=${body.includes("HMR_MARKER_A")}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`warlock dev did not become browser-ready at ${baseUrl}: ${formatError(lastError)}`);
}

async function stopServer() {
  if (!state.server || state.server.exitCode !== null) return;
  state.server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => state.server.once("exit", resolve)),
    delay(5_000).then(() => {
      if (state.server.exitCode === null) state.server.kill("SIGKILL");
    }),
  ]);
}

function captureServerOutput(stream) {
  let remainder = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    remainder += chunk;
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() ?? "";
    state.serverOutput.push(...lines);
    if (state.serverOutput.length > 500) state.serverOutput.splice(0, state.serverOutput.length - 500);
  });
}

async function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function runCommand(command, commandArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.once("error", error => {
      clearTimeout(timer);
      reject(new Error(`${options.label} could not start: ${formatError(error)}`));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            `${options.label} exited ${code}.\nSTDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`,
          ),
        );
      }
    });
  });
}

async function runNpm(npmArgs, options) {
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmArgs], options);
  }
  return runCommand("npm", npmArgs, options);
}

function explicitDevelopmentEnv() {
  return { ...process.env, NODE_ENV: "development" };
}

function assertOutsideWorkspace(candidate) {
  if (isInside(workspaceRoot, candidate) || path.resolve(candidate) === path.resolve(workspaceRoot)) {
    throw new Error(`Temp root ${candidate} is inside monorepo ${workspaceRoot}.`);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function sourceEvidence(file, needle, label) {
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(needle));
  if (index < 0) throw new Error(`Evidence needle ${JSON.stringify(needle)} missing from ${file}.`);
  return { file, line: index + 1, label };
}

async function optionalSourceEvidence(file, needle, label) {
  try {
    return await sourceEvidence(file, needle, label);
  } catch {
    return null;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function assertion(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? null;
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function tail(value, lines = 60) {
  return value.split(/\r?\n/).slice(-lines).join("\n");
}

function formatError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
