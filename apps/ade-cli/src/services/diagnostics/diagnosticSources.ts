import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  tailLogText,
  type DiagnosticLogTail,
  type DiagnosticRedactionContext,
  type DiagnosticVolumeSpace,
} from "./diagnosticReport";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { resolveWindowsSupervisorLogPath } from "../../serviceManager/installWindows";

/**
 * Everything a diagnostic report reads off this machine.
 *
 * `diagnosticReport.ts` renders and redacts; this reads. The desktop's
 * "Report issue" button and `ade report-issue` need the same logs, the same
 * volume pair and the same redaction context, and they had two copies of all
 * of it — so a log added to one report never appeared in the other.
 *
 * Electron-only inputs (the app's own jsonl logs, `readVolumeSpace`, the typed
 * last-failure store) stay in the desktop service and are layered on top.
 */

/** Reads the last 512 KB of a file and tails it. Never throws. */
export function readLogTail(label: string, filePath: string): DiagnosticLogTail {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { label, path: filePath, error: "(not a file)" };
    const readBytes = Math.min(stat.size, 512 * 1024);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(handle, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      return { label, path: filePath, text: tailLogText(buffer.toString("utf8")) };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return { label, path: filePath, error: code === "ENOENT" ? "(not present)" : "(could not be read)" };
  }
}

/** Parses a JSON file, or null for anything that is missing or malformed. */
export function readDiagnosticJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Free space via `statfs`. The desktop passes its own Electron-aware reader. */
export function readVolumeViaStatfs(label: string, dirPath: string): DiagnosticVolumeSpace | null {
  try {
    const stats = fs.statfsSync(dirPath, { bigint: true });
    return {
      label,
      path: dirPath,
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    };
  } catch {
    return null;
  }
}

/** `os.userInfo()` throws when the uid has no passwd entry (slim containers). */
export function readOsUsername(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/**
 * The one note every report carries: neither entry point starts the brain to
 * collect a report, because the machine where the brain will not start is
 * exactly where the report is needed.
 */
export const DIAGNOSTIC_COLLECTION_NOTES = [
  "doctor: not run (the report is collected without starting the background service)",
] as const;

export function diagnosticRedactionContext(
  projectRoot: string | null,
): DiagnosticRedactionContext {
  return {
    homeDir: os.homedir(),
    username: readOsUsername(),
    hostname: os.hostname(),
    // Only the project root is collapsed to a `<project:…>` label; the ADE
    // home is already reduced to `~/.ade` by the home-directory rule, and
    // labelling it would hide which channel's home this machine uses.
    projectRoots: projectRoot ? [projectRoot] : [],
  };
}

export type MachineDiagnosticSourceOptions = {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string | null;
  /**
   * The CLI's own transcript log. The desktop has richer logs of its own and
   * does not write this one.
   */
  includeProjectCliLog?: boolean;
  /** Overridden by the desktop, which reads volumes through Electron's helper. */
  readVolume?: (label: string, dirPath: string) => DiagnosticVolumeSpace | null;
};

export type MachineDiagnosticSources = {
  layout: ReturnType<typeof resolveMachineAdeLayout>;
  logs: DiagnosticLogTail[];
  storage: DiagnosticVolumeSpace[];
  state: {
    machineLastFailure: unknown;
    projectLastFailure: unknown;
    lastWedge: unknown;
  };
  notes: string[];
  redaction: DiagnosticRedactionContext;
};

export function collectMachineDiagnosticSources(
  options: MachineDiagnosticSourceOptions = {},
): MachineDiagnosticSources {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot?.trim() || null;
  const layout = resolveMachineAdeLayout(env);
  const readVolume = options.readVolume ?? readVolumeViaStatfs;

  const logs: DiagnosticLogTail[] = [];
  if (process.platform === "win32") {
    logs.push(readLogTail("Background service supervisor", resolveWindowsSupervisorLogPath({ env })));
  } else {
    logs.push(readLogTail("Background service (stderr)", path.join(layout.runtimeDir, "launchd.err.log")));
  }
  logs.push(readLogTail("Brain", path.join(layout.runtimeDir, "brain.jsonl")));
  if (options.includeProjectCliLog && projectRoot) {
    logs.push(readLogTail("ADE CLI", path.join(projectRoot, ".ade", "transcripts", "logs", "ade-cli.jsonl")));
  }

  const storage = [
    readVolume("ADE home", layout.adeDir),
    projectRoot ? readVolume("Project", projectRoot) : null,
  ].filter((entry): entry is DiagnosticVolumeSpace => entry != null);

  return {
    layout,
    logs,
    storage,
    state: {
      machineLastFailure: readDiagnosticJsonFile(path.join(layout.runtimeDir, "last-failure.json")),
      projectLastFailure: projectRoot
        ? readDiagnosticJsonFile(path.join(projectRoot, ".ade", "runtime", "last-failure.json"))
        : null,
      lastWedge: readDiagnosticJsonFile(path.join(layout.runtimeDir, "last-wedge.json")),
    },
    notes: [...DIAGNOSTIC_COLLECTION_NOTES],
    redaction: diagnosticRedactionContext(projectRoot),
  };
}
