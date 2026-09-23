type ModuleNamespace = Readonly<Record<string, unknown>>;

const SETUP_EXPORT_NAMES = new Set(["config", "loader", "register"]);

export class PageSetupModuleExportError extends Error {
  public constructor(
    public readonly exportName: string,
    public readonly uiFile: string,
    public readonly setupFile: string,
    detail: string,
  ) {
    super(`Cannot compose "${uiFile}" with "${setupFile}": ${detail}`);
    this.name = "PageSetupModuleExportError";
  }
}

/**
 * Combines an optional setup namespace with its UI namespace for the server.
 *
 * The UI file continues to own the component boundary. Setup may provide the
 * three currently portable module exports; duplicate declarations are rejected
 * before any consumer can accidentally choose an order-dependent winner.
 */
export function composePageModule(
  uiModule: ModuleNamespace,
  setupModule: ModuleNamespace | undefined,
  uiFile: string,
  setupFile?: string,
): ModuleNamespace {
  if (setupModule === undefined) return uiModule;

  const source = setupFile ?? "setup module";

  for (const exportName of Object.keys(setupModule)) {
    if (!SETUP_EXPORT_NAMES.has(exportName)) {
      throw new PageSetupModuleExportError(
        exportName,
        uiFile,
        source,
        `setup files may export only config, loader, or register; found "${exportName}".`,
      );
    }

    if (Object.hasOwn(uiModule, exportName)) {
      throw new PageSetupModuleExportError(
        exportName,
        uiFile,
        source,
        `both files export "${exportName}"; declare it in exactly one file.`,
      );
    }
  }

  return { ...uiModule, ...setupModule };
}
