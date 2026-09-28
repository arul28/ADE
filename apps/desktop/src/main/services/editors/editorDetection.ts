import { spawn } from "node:child_process";

import {
  EDITOR_TARGETS,
  editorTargetDefinition,
  type EditorTarget,
} from "../../../shared/editorTargets";
import { editorProcessEnv } from "./editorProcessEnv";
import { resolveWindowsEditorExecutableCached } from "./editorWindowsInstall";

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

/**
 * Where each detected editor was actually found, so opening it does not need
 * PATH. Populated by {@link detectInstalledEditorTargets}; an editor found on
 * PATH keeps its bare `command`, an editor found off PATH (Windows install
 * dirs, registry, Toolbox) stores the verified absolute executable.
 */
const resolvedEditorCommands = new Map<EditorTarget, string>();

/** The absolute command discovered for `target`, or null when none was found. */
export function resolveDetectedEditorCommand(target: EditorTarget): string | null {
  return resolvedEditorCommands.get(target) ?? null;
}

export type EditorDetectionDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  commandSucceeds: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<boolean>;
  resolveWindowsExecutable: (target: EditorTarget) => Promise<string | null>;
};

function defaultDeps(): EditorDetectionDeps {
  return {
    platform: process.platform,
    env: editorProcessEnv(),
    commandSucceeds,
    resolveWindowsExecutable: (target) => resolveWindowsEditorExecutableCached(target),
  };
}

export async function detectInstalledEditorTargets(
  overrides: Partial<EditorDetectionDeps> = {},
): Promise<EditorTarget[]> {
  const deps = { ...defaultDeps(), ...overrides };
  const probeCommand = deps.platform === "win32" ? "where.exe" : "which";
  resolvedEditorCommands.clear();
  // Probe every target in parallel: each probe can burn its full 1.5 s timeout,
  // so a serial walk makes the "Open in" menu wait ~1.5 s per missing editor.
  const detected = await Promise.all(EDITOR_TARGETS.map(async (target): Promise<EditorTarget | null> => {
    if (deps.platform === "darwin" && target.macAppName) {
      const appInstalled = await deps.commandSucceeds("open", ["-Ra", target.macAppName], deps.env);
      if (appInstalled) return target.id;
    }
    if (await deps.commandSucceeds(probeCommand, [target.command], deps.env)) {
      resolvedEditorCommands.set(target.id, target.command);
      return target.id;
    }
    if (deps.platform === "win32") {
      // Not on PATH: look in the default install locations and the uninstall
      // registry. The returned path is recorded so the open action can use it.
      const executable = await deps.resolveWindowsExecutable(target.id);
      if (executable) {
        resolvedEditorCommands.set(target.id, executable);
        return target.id;
      }
    }
    return null;
  }));
  const found = detected.filter((id): id is EditorTarget => id !== null);
  // One entry per real app. `zed` and `zeditor` are two targets for one editor
  // (a legacy CLI alias) and share a `macAppName`; on Windows both also resolve
  // to the same executable, so without this the "Open in" menu lists Zed twice.
  const seenApps = new Set<string>();
  return found.filter((id) => {
    const appName = editorTargetDefinition(id)?.macAppName;
    if (!appName) return true;
    if (seenApps.has(appName)) return false;
    seenApps.add(appName);
    return true;
  });
}

export const _testing = {
  detectInstalledEditorTargets,
  resolveDetectedEditorCommand,
};
