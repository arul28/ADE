import os from "node:os";
import path from "node:path";

export type MachineAdeLayout = {
  adeDir: string;
  projectsPath: string;
  secretsDir: string;
  sockDir: string;
  socketPath: string;
  binDir: string;
  runtimeDir: string;
};

export function resolveMachineAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".ade");
}

export function resolveMachineAdeLayout(env: NodeJS.ProcessEnv = process.env): MachineAdeLayout {
  const adeDir = resolveMachineAdeDir(env);
  const secretsDir = path.join(adeDir, "secrets");
  const sockDir = path.join(adeDir, "sock");
  const socketPath = process.platform === "win32"
    ? "\\\\.\\pipe\\ade-runtime"
    : path.join(sockDir, "ade.sock");
  return {
    adeDir,
    projectsPath: path.join(adeDir, "projects.json"),
    secretsDir,
    sockDir,
    socketPath,
    binDir: path.join(adeDir, "bin"),
    runtimeDir: path.join(adeDir, "runtime"),
  };
}
