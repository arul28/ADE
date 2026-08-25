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
  collectMachineDiagnosticSourcesAsync,
  readLogTail,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticSources";
import { readVolumeSpace } from "../storage/volume";
import { readLastFailure } from "../runtime/lastFailureStore";
import { resolvePathWithinRoot } from "../shared/utils";

export {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  redactDiagnosticText,
  /** Writes the report next to the app's other user data. Best effort. */
  writeDiagnosticReportFile,
} from "../../../../../ade-cli/src/services/diagnostics/diagnosticReport";

/**
 * The two directories automatic reports are written to.
 *
 * There are two because there are two senders: the desktop saves beside the
 * app's user data, and the brain — which has no `app.getPath` — saves under the
 * machine's `~/.ade`. The toast's "View" has to reach BOTH, and the brain's are
 * the ones a user most wants, since a headless send is the one nobody was there
 * for.
 */
export function diagnosticReportRoots(args: { userDataDir: string; adeDir: string }): string[] {
  return [
    path.join(args.userDataDir, "diagnostic-reports"),
    path.join(args.adeDir, "diagnostic-reports"),
  ];
}

/**
 * The absolute path to reveal, or `null` when it is not one of ours.
 *
 * Same `roots.some(...)` shape as `appRevealPath`'s allowlist check, and for
 * the same reason: a renderer hands over a string, and the only paths this may
 * ever open are the ones ADE itself wrote. Anything else — `~/.ssh/id_rsa`, a
 * `..` walk out of a reports directory — is refused rather than revealed.
 */
export function resolveRevealableDiagnosticReport(
  roots: readonly string[],
  candidate: string,
): string | null {
  const normalized = path.resolve(candidate);
  const allowed = roots.some((root) => {
    try {
      resolvePathWithinRoot(root, normalized);
      return true;
    } catch {
      return false;
    }
  });
  return allowed ? normalized : null;
}

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

  // Both optional steps ask the very subsystem the user is reporting as broken
  // -- the local runtime, and a recovery diagnosis that probes the brain's
  // socket. A step that never settles would hold `Promise.all` forever and
  // leave the "Report issue" button spinning, which is exactly the outcome
  // this collector promises can never happen. A synchronous throw out of
  // either one is caught here for the same reason.
  //
  // The machine sources go in the same batch, and through the ASYNC collector:
  // logs, volumes, notes and the redaction context are the same set the
  // headless `ade report-issue` collects, but this is Electron's main process,
  // so the platform commands behind them (a PowerShell `Export-ScheduledTask`,
  // a `journalctl`) may not be spawned synchronously — they would freeze every
  // window and every IPC call for as long as they take, on a report the user
  // often did not ask for. The Electron-only extras below are the only thing
  // this report adds.
  const [sources, osProductVersion, localRuntimeStatus, recoveryDiagnosis] = await Promise.all([
    collectMachineDiagnosticSourcesAsync({ env, projectRoot, readVolume: volumeEntry }),
    readMacProductVersion().catch(() => null),
    bestEffortStep(() => deps.getLocalRuntimeStatus?.() ?? null, deps.stepTimeoutMs),
    projectRoot && deps.diagnoseProject
      ? bestEffortStep(() => deps.diagnoseProject?.(projectRoot) ?? null, deps.stepTimeoutMs)
      : Promise.resolve(null),
  ]);

  // Only what lives under Electron's userData is added here. The project's
  // `main.jsonl` used to be appended at this point from an `app.getPath`-derived
  // directory, which meant it was collected ONLY when a project was open — so a
  // report from the machine-level error screens, the ones a person actually
  // reaches when nothing will open, silently had no `main.jsonl` at all.
  // `collectMachineDiagnosticSources` now owns it, for the open project or for
  // the most recently opened one, and the CLI gets the same file.
  const logs: DiagnosticLogTail[] = [...sources.logs];
  logs.push(readLogTail("Desktop local runtime", path.join(deps.userDataPath, "local-runtime.jsonl")));
  logs.push(readLogTail("Desktop updates", path.join(deps.userDataPath, "ade-update.jsonl")));

  // The typed store rather than the raw file the CLI falls back to: main owns
  // the writer, so it can read the record's real shape.
  const machineLastFailure = (() => {
    try {
      return readLastFailure({ kind: "machine", env });
    } catch {
      return null;
    }
  })();
  // Keyed off the root the shared collector actually used, not the request's:
  // with no project open those differ, and reading the typed store for a root
  // the logs above did not come from would attribute one project's last failure
  // to another's evidence.
  const collectedProjectRoot = sources.projectRoot;
  const projectLastFailure = collectedProjectRoot
    ? (() => {
        try {
          return readLastFailure({ kind: "project", projectRoot: collectedProjectRoot });
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
    storageEnvironment: sources.storageEnvironment,
    logs,
    serviceDefinition: sources.serviceDefinition,
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
