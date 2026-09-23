import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { clientEnvironmentOnly, type SsrBoundaryState } from "./ssr-client-view";

const APP_ROOT = "C:/fixture";
const SETUP_FILE = `${APP_ROOT}/src/web/layout.setup.ts`;
const SETUP_REGISTER_ID = `${SETUP_FILE}?warlock-setup-register`;

function state(): SsrBoundaryState {
  return {
    appRoot: APP_ROOT,
    clientBoundModules: new Set([SETUP_REGISTER_ID]),
    clientImportsByModule: new Map(),
  };
}

function transformOf(plugin: Plugin) {
  if (typeof plugin.transform === "function") return plugin.transform;
  if (plugin.transform && typeof plugin.transform === "object") return plugin.transform.handler;
  throw new Error("expected transform hook");
}

function gate(resolved: string[], serverOnly: ReadonlySet<string>): Plugin {
  return {
    name: "warlock:gate-a-resolve",
    transform(code) {
      return { code };
    },
    resolveId(source) {
      resolved.push(source);
      if (serverOnly.has(source)) throw new Error(`server-only edge: ${source}`);
      return { id: source };
    },
  };
}

const serverContext = {
  environment: { config: { consumer: "server" } },
};

describe("clientEnvironmentOnly setup-register projection", () => {
  it("keeps declaration-level and all-specifier type edges out of Gate A while preserving the register edge", async () => {
    const resolved: string[] = [];
    const boundaryState = state();
    const plugin = clientEnvironmentOnly(
      gate(resolved, new Set(["@server/types", "@server/reexport", "@server/specifier-types"])),
      boundaryState,
    );
    const transform = transformOf(plugin);

    await transform.call(
      serverContext as any,
      [
        `import type { LoaderResult } from "@server/types";`,
        `import { type LoaderInput } from "@server/specifier-types";`,
        `export type { LoaderOutput } from "@server/reexport";`,
        `export const loader = async (): Promise<LoaderResult> => ({}) as LoaderResult;`,
        `import { registerLayout } from "./register-layout";`,
        `export function register() { registerLayout(); }`,
      ].join("\n"),
      SETUP_REGISTER_ID,
      {},
    );

    expect([...boundaryState.clientImportsByModule.entries()]).toEqual([
      [SETUP_REGISTER_ID, new Set(["./register-layout"])],
    ]);
    expect(resolved).toEqual(["./register-layout"]);
  });

  it("keeps raw setup loading server-only while Gate A receives its register-only projection", async () => {
    const resolved: string[] = [];
    const plugin = clientEnvironmentOnly(gate(resolved, new Set(["@warlock.js/auth"])), state());
    const transform = transformOf(plugin);
    const code = [
      `import { authService } from "@warlock.js/auth";`,
      `import { registerLayout } from "./register-layout";`,
      `export const loader = async () => authService;`,
      `export function register() { registerLayout(); }`,
    ].join("\n");

    await expect(transform.call(serverContext as any, code, SETUP_FILE, {})).resolves.toBeNull();
    expect(resolved).toEqual([]);

    await expect(
      transform.call(serverContext as any, code, SETUP_REGISTER_ID, {}),
    ).resolves.toBeDefined();
    expect(resolved).toEqual(["./register-layout"]);
  });

  it("still lets Gate A reject a server-only dependency used by register", async () => {
    const resolved: string[] = [];
    const plugin = clientEnvironmentOnly(gate(resolved, new Set(["@warlock.js/auth"])), state());
    const transform = transformOf(plugin);

    await expect(
      transform.call(
        serverContext as any,
        [
          `import { authService } from "@warlock.js/auth";`,
          `export function register() { return authService; }`,
        ].join("\n"),
        SETUP_REGISTER_ID,
        {},
      ),
    ).rejects.toThrow("server-only edge: @warlock.js/auth");
  });
});
