import os from "node:os";
import path from "node:path";

export type MachineAdeLayout = {
  adeDir: string;
  projectsPath: string;
  secretsDir: string;
  sockDir: string;
  socketPath: string;
  /**
   * Side-channel JSON-RPC socket for Electron-main-only domains
   * (currently `built_in_browser`). Hosted by the desktop main process; the
   * runtime daemon proxies calls through here when present. The runtime daemon
   * cannot host these domains itself because they need Electron APIs
   * (WebContentsView, etc.) that aren't available under ELECTRON_RUN_AS_NODE.
   */
  desktopBridgeSocketPath: string;
  binDir: string;
  runtimeDir: string;
  personalChatsDir?: string;
  personalChatsStateRoot?: string;
  personalChatsWorkspaceRoot?: string;
};

export function resolveMachineAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".ade");
}

function windowsPipePathForAdeDir(adeDir: string): string {
  const homeName = path.basename(adeDir).replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!homeName || homeName === "-ade") return "\\\\.\\pipe\\ade-runtime";
  return `\\\\.\\pipe\\ade-runtime-${homeName.replace(/^-+/, "")}`;
}

function windowsDesktopBridgePipePathForAdeDir(adeDir: string): string {
  const homeName = path.basename(adeDir).replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!homeName || homeName === "-ade") return "\\\\.\\pipe\\ade-desktop-bridge";
  return `\\\\.\\pipe\\ade-desktop-bridge-${homeName.replace(/^-+/, "")}`;
}

export function resolveMachineAdeLayout(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): MachineAdeLayout {
  const adeDir = resolveMachineAdeDir(env);
  const secretsDir = path.join(adeDir, "secrets");
  const sockDir = path.join(adeDir, "sock");
  const socketPath = platform === "win32"
    ? windowsPipePathForAdeDir(adeDir)
    : path.join(sockDir, "ade.sock");
  const desktopBridgeSocketPath = platform === "win32"
    ? windowsDesktopBridgePipePathForAdeDir(adeDir)
    : path.join(sockDir, "desktop-bridge.sock");
  return {
    adeDir,
    projectsPath: path.join(adeDir, "projects.json"),
    secretsDir,
    sockDir,
    socketPath,
    desktopBridgeSocketPath,
    binDir: path.join(adeDir, "bin"),
    runtimeDir: path.join(adeDir, "runtime"),
    personalChatsDir: path.join(adeDir, "personal-chats"),
    personalChatsStateRoot: path.join(adeDir, "personal-chats", "state"),
    personalChatsWorkspaceRoot: path.join(adeDir, "personal-chats", "workspaces"),
  };
}
