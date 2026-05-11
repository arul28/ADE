import path from "node:path";

export type DesktopPackageChannel = "alpha" | "beta";

export type DesktopUserDataPathArgs = {
  channel: DesktopPackageChannel | null;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  appDataPath: string;
};

export type ElectronAppDataPathArgs = {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir: string;
};

function hasEnvValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveElectronAppDataPath(args: ElectronAppDataPathArgs): string {
  const env = args.env ?? process.env;
  if (args.platform === "darwin") {
    return path.join(args.homeDir, "Library", "Application Support");
  }
  if (args.platform === "win32") {
    return env.APPDATA || path.win32.join(args.homeDir, "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME || path.join(args.homeDir, ".config");
}

export function resolveDesktopUserDataPath(args: DesktopUserDataPathArgs): string | null {
  const env = args.env ?? process.env;
  const explicitPath = env.ADE_DESKTOP_USER_DATA_PATH;
  if (hasEnvValue(explicitPath)) {
    return path.resolve(String(explicitPath));
  }

  if (args.channel) {
    return path.join(args.appDataPath, `ade-desktop-${args.channel}`);
  }

  if (!args.isPackaged || hasEnvValue(env.VITE_DEV_SERVER_URL) || hasEnvValue(env.ADE_DEV_RUNTIME_SOCKET_PATH)) {
    return path.join(args.appDataPath, "ade-desktop-dev");
  }

  return null;
}
