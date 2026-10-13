/**
 * This desktop's side of a browser command sent by an agent on another
 * machine (`built_in_browser_remote_call`): run it here as that chat, and pack
 * the files its result points at so the agent's machine can keep them.
 *
 * The renderer receives the command (it holds the connection to the other
 * machine and knows which project's tabs the chat means), and calls this
 * through IPC because the browser lives in the main process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES,
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES,
  isBuiltInBrowserRemoteCallMethod,
  type BuiltInBrowserRemoteAgentCallOutcome,
  type BuiltInBrowserRemoteCallFile,
} from "../../../shared/types/builtInBrowserRemote";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { dispatchBuiltInBrowserAgentCall } from "./builtInBrowserAgentDispatch";

/** Every screenshot and element map the browser writes lives under a directory of this name. */
const OBSERVATION_DIR_SEGMENT = "browser-observations";
const MAX_POINTER_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `filePath`s in a result that name an observation file on this machine,
 * read and packed. Only a real file inside a `browser-observations` directory
 * travels, after symlinks are resolved: a result is the page's own data, and a
 * path it carries must not be able to name any other file on the user's
 * computer.
 */
export function packRemoteCallFiles(
  result: unknown,
  readFile: (filePath: string) => Buffer | null = readObservationFile,
): BuiltInBrowserRemoteCallFile[] {
  const files: BuiltInBrowserRemoteCallFile[] = [];
  const visit = (node: unknown, pointer: string[]): void => {
    if (!isRecord(node) || pointer.length > MAX_POINTER_DEPTH) return;
    for (const [key, value] of Object.entries(node)) {
      if (files.length >= BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES) return;
      if (key === "filePath" && typeof value === "string" && value.trim()) {
        const bytes = isObservationFilePath(value) ? readFile(value) : null;
        if (bytes) {
          files.push({
            pointer: [...pointer, key],
            fileName: path.basename(value),
            base64: bytes.toString("base64"),
          });
        }
        continue;
      }
      visit(value, [...pointer, key]);
    }
  };
  visit(result, []);
  return files;
}

function isObservationFilePath(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  return path.normalize(filePath).split(path.sep).includes(OBSERVATION_DIR_SEGMENT);
}

function readObservationFile(filePath: string): Buffer | null {
  try {
    const realPath = fs.realpathSync(filePath);
    if (!isObservationFilePath(realPath)) return null;
    const stat = fs.statSync(realPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES) return null;
    return fs.readFileSync(realPath);
  } catch {
    return null;
  }
}

/** This computer's name, for the agent to tell the user where the tab is. */
function machineName(): string {
  return os.hostname().replace(/\.local$/i, "") || "the user's computer";
}

/** Run one command for an agent on another machine. A failure is an outcome, never a throw. */
export async function runRemoteAgentBrowserCall(args: {
  service: BuiltInBrowserService;
  method: string;
  input: Record<string, unknown>;
}): Promise<BuiltInBrowserRemoteAgentCallOutcome> {
  if (!isBuiltInBrowserRemoteCallMethod(args.method)) {
    return {
      ok: false,
      error: `built_in_browser.${args.method} cannot be run for an agent on another machine.`,
      machineName: machineName(),
    };
  }
  try {
    const result = await dispatchBuiltInBrowserAgentCall(args.service, args.method, args.input);
    return { ok: true, result, files: packRemoteCallFiles(result), machineName: machineName() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), machineName: machineName() };
  }
}
