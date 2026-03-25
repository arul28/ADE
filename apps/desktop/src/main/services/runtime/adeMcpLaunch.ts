import fs from "node:fs";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { ComputerUsePolicy } from "../../../shared/types";

export type AdeMcpLaunchMode = "bundled_proxy" | "headless_built" | "headless_source";

export type AdeMcpLaunch = {
  mode: AdeMcpLaunchMode;
  command: string;
  cmdArgs: string[];
  env: Record<string, string>;
  entryPath: string;
  runtimeRoot: string | null;
  socketPath: string;
  packaged: boolean;
  resourcesPath: string | null;
};

type AdeMcpLaunchArgs = {
  projectRoot?: string;
  workspaceRoot: string;
  runtimeRoot?: string;
  missionId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  defaultRole?: string;
  ownerId?: string;
  computerUsePolicy?: ComputerUsePolicy | null;
  bundledProxyPath?: string;
  preferBundledProxy?: boolean;
};

function pathExists(targetPath: string | null | undefined): targetPath is string {
  return Boolean(targetPath && fs.existsSync(targetPath));
}

function resolveResourcesPath(): string | null {
  return typeof process.resourcesPath === "string" && process.resourcesPath.trim().length > 0
    ? process.resourcesPath
    : null;
}

function resolveBundledProxyPath(overridePath?: string): string | null {
  const resourcesPath = resolveResourcesPath();
  const candidates = [
    overridePath,
    ...(resourcesPath
      ? [
        path.join(resourcesPath, "app.asar.unpacked", "dist", "main", "adeMcpProxy.cjs"),
        path.join(resourcesPath, "dist", "main", "adeMcpProxy.cjs"),
      ]
      : []),
    path.join(__dirname, "adeMcpProxy.cjs"),
    path.resolve(process.cwd(), "dist", "main", "adeMcpProxy.cjs"),
    path.resolve(process.cwd(), "apps", "desktop", "dist", "main", "adeMcpProxy.cjs"),
  ];

  for (const candidate of candidates) {
    if (!pathExists(candidate)) continue;
    return path.resolve(candidate);
  }

  return null;
}

export function resolveRepoRuntimeRoot(): string {
  const startPoints = [
    process.cwd(),
    __dirname,
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
  ];

  for (const start of startPoints) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
      if (fs.existsSync(path.join(dir, "apps", "mcp-server", "package.json"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return path.resolve(process.cwd());
}

function buildLaunchEnv(args: {
  projectRoot: string;
  workspaceRoot: string;
  socketPath: string;
} & Pick<AdeMcpLaunchArgs, "missionId" | "runId" | "stepId" | "attemptId" | "defaultRole" | "ownerId" | "computerUsePolicy">): Record<string, string> {
  return {
    ADE_PROJECT_ROOT: args.projectRoot,
    ADE_WORKSPACE_ROOT: args.workspaceRoot,
    ADE_MCP_SOCKET_PATH: args.socketPath,
    ADE_MISSION_ID: args.missionId ?? "",
    ADE_RUN_ID: args.runId ?? "",
    ADE_STEP_ID: args.stepId ?? "",
    ADE_ATTEMPT_ID: args.attemptId ?? "",
    ADE_DEFAULT_ROLE: args.defaultRole ?? "agent",
    ADE_OWNER_ID: args.ownerId ?? "",
    ADE_COMPUTER_USE_MODE: args.computerUsePolicy?.mode ?? "",
    ADE_COMPUTER_USE_ALLOW_LOCAL_FALLBACK:
      typeof args.computerUsePolicy?.allowLocalFallback === "boolean"
        ? (args.computerUsePolicy.allowLocalFallback ? "1" : "0")
        : "",
    ADE_COMPUTER_USE_RETAIN_ARTIFACTS:
      typeof args.computerUsePolicy?.retainArtifacts === "boolean"
        ? (args.computerUsePolicy.retainArtifacts ? "1" : "0")
        : "",
    ADE_COMPUTER_USE_PREFERRED_BACKEND: args.computerUsePolicy?.preferredBackend ?? "",
  };
}

export function resolveDesktopAdeMcpLaunch(args: AdeMcpLaunchArgs): AdeMcpLaunch {
  const projectRoot = typeof args.projectRoot === "string" && args.projectRoot.trim().length > 0
    ? path.resolve(args.projectRoot)
    : path.resolve(args.workspaceRoot);
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const socketPath = resolveAdeLayout(projectRoot).socketPath;
  const resourcesPath = resolveResourcesPath();
  const env = buildLaunchEnv({
    projectRoot,
    workspaceRoot,
    missionId: args.missionId,
    runId: args.runId,
    stepId: args.stepId,
    attemptId: args.attemptId,
    defaultRole: args.defaultRole,
    ownerId: args.ownerId,
    socketPath,
    computerUsePolicy: args.computerUsePolicy,
  });
  const bundledProxyPath = args.preferBundledProxy === false ? null : resolveBundledProxyPath(args.bundledProxyPath);
  const packaged = __dirname.includes("app.asar");

  if (bundledProxyPath) {
    return {
      mode: "bundled_proxy",
      command: process.execPath,
      cmdArgs: [bundledProxyPath, "--project-root", projectRoot, "--workspace-root", workspaceRoot],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      entryPath: bundledProxyPath,
      runtimeRoot: args.runtimeRoot ? path.resolve(args.runtimeRoot) : null,
      socketPath,
      packaged,
      resourcesPath,
    };
  }

  const runtimeRoot = path.resolve(args.runtimeRoot ?? resolveRepoRuntimeRoot());
  const mcpServerDir = path.resolve(runtimeRoot, "apps", "mcp-server");
  const builtEntry = path.join(mcpServerDir, "dist", "index.cjs");
  const srcEntry = path.join(mcpServerDir, "src", "index.ts");

  if (fs.existsSync(builtEntry)) {
    return {
      mode: "headless_built",
      command: "node",
      cmdArgs: [builtEntry, "--project-root", projectRoot, "--workspace-root", workspaceRoot],
      env,
      entryPath: builtEntry,
      runtimeRoot,
      socketPath,
      packaged,
      resourcesPath,
    };
  }

  return {
    mode: "headless_source",
    command: "npx",
    cmdArgs: ["tsx", srcEntry, "--project-root", projectRoot, "--workspace-root", workspaceRoot],
    env,
    entryPath: srcEntry,
    runtimeRoot,
    socketPath,
    packaged,
    resourcesPath,
  };
}
