import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  diagnosticReportFilePath,
  tailLogText,
  type DiagnosticLogTail,
  type DiagnosticReportContext,
  type DiagnosticVolumeSpace,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticReport";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { resolveWindowsSupervisorLogPath } from "../../../../../ade-cli/src/serviceManager/installWindows";
import { readVolumeSpace } from "../storage/volume";
import { readLastFailure } from "../runtime/lastFailureStore";

export {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  redactDiagnosticText,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticReport";

export type DiagnosticReportRequest = DiagnosticReportContext & {
  /** Verbatim `UpdateTransactionResult` (or anything JSON) from the caller. */
  updateTransaction?: unknown;
};

export type DiagnosticReportDeps = {
  appVersion: string | null;
  packageChannel: string | null;
  isPackaged: boolean;
  /** `app.getPath("userData")` — where the desktop's own jsonl logs live. */
  userDataPath: string;
  /** Directory the written report file goes in. */
  reportsDir: string;
  installId: string | null;
  /** Raw account user id; hashed here and never stored or sent verbatim. */
  accountUserId?: string | null;
  /** Project `.ade/logs` directory for the open project, when there is one. */
  projectLogsDir?: string | null;
  getLocalRuntimeStatus?: () => Promise<unknown> | unknown;
  diagnoseProject?: (projectRoot: string) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type DiagnosticReportResult = {
  report: string;
  filePath: string;
  issueUrl: string;
  installId: string;
};

/** Truncated one-way hash: correlatable across reports, never reversible. */
export function hashAccountUserId(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(`ade-account:${trimmed}`).digest("hex").slice(0, 12);
}

function readMacProductVersion(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/sw_vers", ["-productVersion"], { timeout: 2_000 }, (error, stdout) => {
        resolve(error ? null : stdout.trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function readLogTail(label: string, filePath: string): DiagnosticLogTail {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { label, path: filePath, error: "(not a file)" };
    // Read at most the last 512 KB off disk; the tail helper trims from there.
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
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return { label, path: filePath, error: code === "ENOENT" ? "(not present)" : "(could not be read)" };
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function volumeEntry(label: string, dirPath: string): DiagnosticVolumeSpace | null {
  const space = readVolumeSpace(dirPath);
  if (!space) return null;
  return { label, path: dirPath, freeBytes: space.freeBytes, totalBytes: space.totalBytes };
}

/**
 * Gathers everything the report needs from this machine and renders it. Every
 * step is best-effort: a missing log or a runtime that will not answer must
 * never stop a user from filing an issue.
 */
export async function collectDiagnosticReport(
  deps: DiagnosticReportDeps,
  request: DiagnosticReportRequest,
): Promise<DiagnosticReportResult> {
  const env = deps.env ?? process.env;
  const at = deps.now?.() ?? new Date();
  const layout = resolveMachineAdeLayout(env);
  const projectRoot = request.projectRoot?.trim() || null;

  const [osProductVersion, localRuntimeStatus, recoveryDiagnosis] = await Promise.all([
    readMacProductVersion().catch(() => null),
    Promise.resolve()
      .then(() => deps.getLocalRuntimeStatus?.())
      .catch(() => null),
    projectRoot && deps.diagnoseProject
      ? deps.diagnoseProject(projectRoot).catch(() => null)
      : Promise.resolve(null),
  ]);

  const logs: DiagnosticLogTail[] = [];
  if (process.platform === "win32") {
    logs.push(readLogTail("Background service supervisor", resolveWindowsSupervisorLogPath({ env })));
  } else {
    logs.push(readLogTail("Background service (stderr)", path.join(layout.runtimeDir, "launchd.err.log")));
  }
  logs.push(readLogTail("Brain", path.join(layout.runtimeDir, "brain.jsonl")));
  logs.push(readLogTail("Desktop local runtime", path.join(deps.userDataPath, "local-runtime.jsonl")));
  logs.push(readLogTail("Desktop updates", path.join(deps.userDataPath, "ade-update.jsonl")));
  if (deps.projectLogsDir) {
    logs.push(readLogTail("Desktop main", path.join(deps.projectLogsDir, "main.jsonl")));
  }

  const storage = [
    volumeEntry("ADE home", layout.adeDir),
    projectRoot ? volumeEntry("Project", projectRoot) : null,
  ].filter((entry): entry is DiagnosticVolumeSpace => entry != null);

  const machineLastFailure = (() => {
    try {
      return readLastFailure({ kind: "machine", env });
    } catch {
      return null;
    }
  })();
  const projectLastFailure = projectRoot
    ? (() => {
        try {
          return readLastFailure({ kind: "project", projectRoot });
        } catch {
          return null;
        }
      })()
    : null;
  const lastWedge = readJsonFile(path.join(layout.runtimeDir, "last-wedge.json"));

  const installId = deps.installId?.trim() || "unknown";

  const report = buildDiagnosticReport({
    generatedAt: at.toISOString(),
    app: {
      version: deps.appVersion,
      packageChannel: deps.packageChannel,
      isPackaged: deps.isPackaged,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osProductVersion,
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.versions.node ?? null,
      chromeVersion: process.versions.chrome ?? null,
      timezoneOffsetMinutes: -at.getTimezoneOffset(),
    },
    identity: {
      installId,
      accountHash: hashAccountUserId(deps.accountUserId),
    },
    context: {
      surface: request.surface,
      headline: request.headline ?? null,
      code: request.code ?? null,
      technicalDetail: request.technicalDetail ?? null,
      projectRoot,
    },
    state: {
      localRuntimeStatus: localRuntimeStatus ?? null,
      recoveryDiagnosis: recoveryDiagnosis ?? null,
      machineLastFailure,
      projectLastFailure,
      lastWedge,
      updateTransaction: request.updateTransaction ?? null,
    },
    storage,
    logs,
    notes: ["doctor: not run (the report is collected without starting the background service)"],
    redaction: {
      homeDir: os.homedir(),
      username: os.userInfo().username,
      hostname: os.hostname(),
      // Only the project root is collapsed to a `<project:…>` label; the ADE
      // home is already reduced to `~/.ade` by the home-directory rule, and
      // labelling it would hide which channel's home this machine uses.
      projectRoots: projectRoot ? [projectRoot] : [],
    },
  });

  const filePath = diagnosticReportFilePath(deps.reportsDir, request.surface, at);
  const issueUrl = buildDiagnosticIssueUrl({
    surface: request.surface,
    headline: request.headline ?? null,
    code: request.code ?? null,
    appVersion: deps.appVersion,
    platform: process.platform,
    arch: process.arch,
    installId,
  });

  return { report, filePath, issueUrl, installId };
}

/** Writes the report next to the app's other user data. Best effort. */
export function writeDiagnosticReportFile(filePath: string, report: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, report, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
