import { spawn } from "node:child_process";

import {
  EDITOR_TARGETS,
  editorTargetDefinition,
  type EditorTarget,
} from "../../../shared/editorTargets";
import { editorProcessEnv } from "./editorProcessEnv";

function commandSucceeds(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 1_500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, timeoutMs);
    } catch {
      finish(false);
    }
  });
}

export async function detectInstalledEditorTargets(): Promise<EditorTarget[]> {
  const env = editorProcessEnv();
  const probeCommand = process.platform === "win32" ? "where.exe" : "which";
  const installed = await Promise.all(EDITOR_TARGETS.map(async (target) => {
    if (process.platform === "darwin" && target.macAppName) {
      const appInstalled = await commandSucceeds("open", ["-Ra", target.macAppName], env);
      if (appInstalled) return target.id;
    }
    return await commandSucceeds(probeCommand, [target.command], env) ? target.id : null;
  }));
  const found = installed.filter((target): target is EditorTarget => target !== null);
  if (process.platform !== "darwin") return found;
  const seenMacApps = new Set<string>();
  return found.filter((id) => {
    const appName = editorTargetDefinition(id)?.macAppName;
    if (!appName) return true;
    if (seenMacApps.has(appName)) return false;
    seenMacApps.add(appName);
    return true;
  });
}
