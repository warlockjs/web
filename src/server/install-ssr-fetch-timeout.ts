import type { ViteDevServer } from "vite";
import { resolveSsrFetchTimeoutMs, withSsrFetchTimeout } from "./ssr-fetch-timeout";

/**
 * Route the dev server's `ssrLoadModule()` through a module runner whose fetch
 * timeout is configurable, and name the module that timed out.
 *
 * Vite's legacy `ssrLoadModule()` compatibility runner hard-codes its
 * transport's 60s invoke timeout. Supplying the transport to our own
 * `ModuleRunner` is the supported seam, and it keeps HMR on Vite's channel.
 *
 * Its own module so the connector's tests can replace this one step while
 * still driving a fake Vite server.
 */
export async function installSsrFetchTimeout(vite: ViteDevServer, option?: number): Promise<void> {
  const { createServerModuleRunnerTransport } = await import("vite");
  const { ModuleRunner } = await import("vite/module-runner");

  const timeoutMs = resolveSsrFetchTimeoutMs(option);
  let fetchingModuleId: string | undefined;
  const transport = createServerModuleRunnerTransport({ channel: vite.environments.ssr.hot });
  const send = transport.send!;

  transport.send = (payload) => {
    if (
      payload.type === "custom" &&
      payload.event === "vite:invoke" &&
      payload.data.name === "fetchModule"
    ) {
      const moduleId = payload.data.data[0];
      if (typeof moduleId === "string") fetchingModuleId = moduleId;
    }

    return send(payload);
  };

  const runner = new ModuleRunner({
    transport: {
      ...transport,
      send: transport.send!,
      timeout: timeoutMs,
    },
  });

  vite.ssrLoadModule = (moduleId) =>
    withSsrFetchTimeout(() => fetchingModuleId ?? moduleId, () => runner.import(moduleId), timeoutMs);

  const close = vite.close.bind(vite);
  vite.close = async () => {
    await runner.close();
    await close();
  };
}
