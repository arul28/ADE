import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  /** Writes the report next to the app's other user data. Best effort. */
  writeDiagnosticReportFile,
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
  /** Deadline for each optional step above. Test seam; defaults to 8s. */
  stepTimeoutMs?: number;
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

/** Deadline for one optional collection step. */
const DIAGNOSTIC_STEP_TIMEOUT_MS = 8_000;

/**
 * Runs one optional step and always settles: a rejection, a synchronous throw
 * and a promise that never answers all collapse to null. Whatever the step
 * would have contributed is simply absent from the report -- far better than a
 * report the user can never get.
 */
function bestEffortStep<T>(
  run: () => Promise<T> | T,
  timeoutMs = DIAGNOSTIC_STEP_TIMEOUT_MS,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    Promise.resolve()
      .then(run)
      .catch(() => null),
    new Promise<null>((resolve) => {
      // Unref'd so an outstanding step can never hold the process open.
      timer = setTimeout(() => resolve(null), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
    // Losing the race does not cancel the timer, so a step that answers first
    // would otherwise leave a handle per report alive for the full deadline.
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

  // Both optional steps ask the very subsystem the user is reporting as broken
  // -- the local runtime, and a recovery diagnosis that probes the brain's
  // socket. A step that never settles would hold `Promise.all` forever and
  // leave the "Report issue" button spinning, which is exactly the outcome
  // this collector promises can never happen. A synchronous throw out of
  // either one is caught here for the same reason.
  const [osProductVersion, localRuntimeStatus, recoveryDiagnosis] = await Promise.all([
    readMacProductVersion().catch(() => null),
    bestEffortStep(() => deps.getLocalRuntimeStatus?.() ?? null, deps.stepTimeoutMs),
    projectRoot && deps.diagnoseProject
      ? bestEffortStep(() => deps.diagnoseProject?.(projectRoot) ?? null, deps.stepTimeoutMs)
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
