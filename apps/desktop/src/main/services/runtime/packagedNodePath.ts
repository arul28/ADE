import path from "node:path";

export type PackagedRuntimeNodePathOptions = {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  existingNodePath?: string;
};

export function buildPackagedRuntimeNodeModulePaths(
  options: Omit<PackagedRuntimeNodePathOptions, "existingNodePath"> = {},
): string[] {
  const resourcesPath = options.resourcesPath;
  if (!resourcesPath) return [];

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform === "darwin") {
    const archAsar = arch === "arm64" ? "app-arm64.asar" : "app-x64.asar";
    return [
      path.join(resourcesPath, `${archAsar}.unpacked`, "node_modules"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
      path.join(resourcesPath, archAsar, "node_modules"),
      path.join(resourcesPath, "app.asar", "node_modules"),
    ];
  }

  return [
    path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
    path.join(resourcesPath, "app.asar", "node_modules"),
  ];
}

export function buildPackagedRuntimeNodePath(options: PackagedRuntimeNodePathOptions = {}): string | undefined {
  const entries = buildPackagedRuntimeNodeModulePaths(options);
  const existingNodePath = options.existingNodePath ?? process.env.NODE_PATH;
  if (existingNodePath?.trim()) entries.push(existingNodePath);
  return entries.length ? entries.join(path.delimiter) : undefined;
}
