import { spawn } from "node:child_process";

import {
  buildRemoteEditorUrl,
  editorTargetDefinition,
  type OpenPathTarget,
} from "../../../shared/editorTargets";
import { openEditorExternalUrl } from "../shared/externalLinks";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { editorProcessEnv } from "./editorProcessEnv";

async function launchDetached(
  command: string,
  args: string[],
  options?: { windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit"; env?: NodeJS.ProcessEnv },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const resolveOn = options?.resolveOn ?? "spawn";
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: options?.windowsVerbatimArguments,
        env: options?.env,
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("spawn", () => {
        if (resolveOn !== "spawn") return;
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      });
      child.once("exit", (code) => {
        if (resolveOn !== "exit") return;
        if (settled) return;
        settled = true;
        child.unref();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`exit code ${code}`));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function launchAttempts(
  attempts: Array<{ command: string; args: string[]; windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit" }>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      await launchDetached(attempt.command, attempt.args, {
        windowsVerbatimArguments: attempt.windowsVerbatimArguments,
        resolveOn: attempt.resolveOn,
        env,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to launch external editor.");
}

export async function openRemoteWorkspaceInEditor(args: {
  target: OpenPathTarget;
  hostname: string;
  rootPath: string;
}): Promise<void> {
  if (args.target === "default" || args.target === "finder") {
    throw new Error("Remote editor opening requires a specific editor.");
  }
  const url = buildRemoteEditorUrl(args.target, args.hostname, args.rootPath);
  if (!url) throw new Error("This editor cannot open the selected remote project.");
  await openEditorExternalUrl(url);
}

export async function openLocalWorkspaceInEditor(args: {
  target: OpenPathTarget;
  targetPath: string;
  openDefault: (path: string) => Promise<void>;
  revealInFolder: (path: string) => void;
}): Promise<void> {
  if (args.target === "default") {
    await args.openDefault(args.targetPath);
    return;
  }
  if (args.target === "finder") {
    args.revealInFolder(args.targetPath);
    return;
  }

  const editor = editorTargetDefinition(args.target);
  if (!editor) throw new Error("Unsupported editor target.");
  const env = editorProcessEnv();
  const attempts: Array<{ command: string; args: string[]; windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit" }> = [];

  if (process.platform === "darwin" && editor.macAppName) {
    attempts.push({ command: "open", args: ["-a", editor.macAppName, args.targetPath] });
  }
  const invocation = resolveCliSpawnInvocation(editor.command, [args.targetPath], env);
  attempts.push({
    command: invocation.command,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  try {
    await launchAttempts(attempts, env);
  } catch {
    throw new Error(`Unable to open file in ${args.target}. Ensure it is installed and available.`);
  }
}
