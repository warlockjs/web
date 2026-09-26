import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SitesConfig } from "../sites/site-config.types";

/** The build-safe subset of `web.sites`; runtime callbacks never cross this boundary. */
export type WebBuildConfig = { sites?: SitesConfig };

function staticSites(sites: SitesConfig | undefined): SitesConfig | undefined {
  if (sites === undefined) return undefined;

  return Object.fromEntries(
    Object.entries(sites).map(([key, site]) => [
      key,
      {
        pages: site.pages,
        ...("hosts" in site ? { hosts: [...site.hosts] } : { dynamic: true as const }),
        ...(site.basePath === undefined ? {} : { basePath: site.basePath }),
        ...(site.localeRouting === undefined ? {} : { localeRouting: { ...site.localeRouting } }),
      },
    ]),
  );
}

/**
 * The production builder statically imports every `src/config/*.ts` file into
 * its generated config-loader. Its build hooks run before that generated module
 * is evaluated, so this is the matching direct import for the one config value
 * needed to shape the client and barrel inputs.
 */
export async function loadWebBuildConfig(appRoot: string): Promise<WebBuildConfig> {
  const configFile = ["web.ts", "web.tsx"]
    .map((name) => path.join(appRoot, "src", "config", name))
    .find(existsSync);

  if (configFile === undefined) return {};

  const module = (await import(pathToFileURL(configFile).href)) as { default?: { sites?: SitesConfig } };

  return { sites: staticSites(module.default?.sites) };
}
