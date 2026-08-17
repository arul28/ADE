import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  diagnosticReportFilePath,
  type DiagnosticLogTail,
  type DiagnosticReportContext,
  type DiagnosticVolumeSpace,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticReport";
import {
  collectMachineDiagnosticSources,
  readLogTail,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticSources";
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
  /**
   * Caller-supplied notes appended to the machine-collected ones — how a
   * handler explains a degraded report, e.g. a project root it could not
   * recognise and therefore did not collect project state for.
   */
  extraNotes?: readonly string[];
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
  const projectRoot = request.projectRoot?.trim() || null;
  // Logs, volumes, notes and the redaction context are the same set the
  // headless `ade report-issue` collects; the Electron-only extras below are
  // the only thing this report adds.
  const sources = collectMachineDiagnosticSources({
    env,
    projectRoot,
    readVolume: volumeEntry,
  });

  const [osProductVersion, localRuntimeStatus, recoveryDiagnosis] = await Promise.all([
    readMacProductVersion().catch(() => null),
    Promise.resolve()
      .then(() => deps.getLocalRuntimeStatus?.())
      .catch(() => null),
    projectRoot && deps.diagnoseProject
      ? deps.diagnoseProject(projectRoot).catch(() => null)
      : Promise.resolve(null),
  ]);

  const logs: DiagnosticLogTail[] = [...sources.logs];
  logs.push(readLogTail("Desktop local runtime", path.join(deps.userDataPath, "local-runtime.jsonl")));
  logs.push(readLogTail("Desktop updates", path.join(deps.userDataPath, "ade-update.jsonl")));
  if (deps.projectLogsDir) {
    logs.push(readLogTail("Desktop main", path.join(deps.projectLogsDir, "main.jsonl")));
  }

  // The typed store rather than the raw file the CLI falls back to: main owns
  // the writer, so it can read the record's real shape.
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

  const installId = deps.installId?.trim() || "unknown";
  const redaction = sources.redaction;

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
      lastWedge: sources.state.lastWedge,
      updateTransaction: request.updateTransaction ?? null,
    },
    storage: sources.storage,
    logs,
    notes: [...sources.notes, ...(request.extraNotes ?? [])],
    redaction,
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
    redaction,
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
