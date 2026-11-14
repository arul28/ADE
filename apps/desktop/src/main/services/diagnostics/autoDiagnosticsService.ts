import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import {
  resolveDiagnosticsUploadBaseUrl,
  uploadDiagnosticReport,
  type DiagnosticUploadRequest,
} from "../../../shared/diagnosticsUpload";
import { writeDiagnosticReportFile } from "./diagnosticReportService";
import {
  runAutoDiagnosticsSend,
  type AutoDiagnosticsLogger,
  type AutoDiagnosticsOutcome,
  type AutoDiagnosticsSentNotice,
  type AutoDiagnosticsUploadResult,
} from "./autoDiagnosticsSend";
import {
  ackAutoDiagnosticsNotices,
  claimManualDiagnosticsSend,
  completeAutoDiagnosticsSend,
  isAutoDiagnosticsEnabled,
  listPendingAutoDiagnosticsNotices,
  readAutoDiagnosticsState,
  setAutoDiagnosticsEnabled,
  MANUAL_DIAGNOSTICS_FAILURE_CODE,
  MAX_MANUAL_DIAGNOSTICS_PER_WINDOW,
  type AutoDiagnosticsNotice,
} from "./autoDiagnosticsStore";
import type {
  DiagnosticsManualSendResult,
  DiagnosticsPrepareResult,
} from "../../../shared/types/diagnostics";
import { randomUUID } from "node:crypto";

/**
 * Sends the diagnostic report nobody was ever going to press the button for.
 *
 * "Report issue" only ever fires when somebody notices the button, decides the
 * failure is worth reporting, and follows through — on a screen that already
 * told them ADE is broken. The reports that would explain the worst failures
 * are exactly the ones that never arrive. So when ADE hits a failure it already
 * classified, it sends the same already-redacted report by itself.
 *
 * The guardrails are the feature, not decoration around it:
 *   - an on-by-default opt-out, honoured by this process and by the brain:
 *     `DO_NOT_TRACK=1`, or an explicit off persisted by an earlier build (there
 *     is no Settings control for it);
 *   - a hard client budget (one per failure code, three total, per day, per
 *     install) reserved before the request so nothing here can become a loop;
 *   - a toast on every send, so it is never something that happened silently;
 *   - and total silence on failure. A user staring at a broken app must not
 *     also be told that the thing they did not ask for did not work.
 *
 * All of which is `runAutoDiagnosticsSend`, shared with the brain's sender.
 * What lives here is only what is specific to the desktop: how a report gets
 * built, that it uploads anonymously, and the spend counts the settings pane shows.
 */

type ManualSendFailure = Extract<DiagnosticsManualSendResult, { ok: false }>["reason"];

export type AutoDiagnosticsRequest = {
  /** Short machine code, e.g. `brain_crash_looping`. Never free text. */
  failureCode: string;
  /** Which screen or subsystem produced it; matches the manual surfaces. */
  surface: string;
  projectRoot?: string | null;
  headline?: string | null;
  technicalDetail?: string | null;
  /** The screen's own error code, when it differs from `failureCode`. */
  code?: string | null;
  /** Lines appended to the report's notes, e.g. a project root that was dropped. */
  extraNotes?: readonly string[];
};

/** What an error screen's report dialog adds to a manual send. Already validated by main. */
export type ManualDiagnosticsContext = Omit<AutoDiagnosticsRequest, "failureCode">;

export type { AutoDiagnosticsOutcome, AutoDiagnosticsSentNotice };

/** How long a prepared report waits for Send. */
export const PREPARED_REPORT_TTL_MS = 10 * 60_000;
/** Prepared reports held at once; a newer one pushes out the oldest. */
const MAX_PREPARED_REPORTS = 4;
/** Mirror of `USER_FEEDBACK_MAX_CHARS` (`main/sentry/userFeedback.ts`), kept here so this service does not load Sentry. */
const MANUAL_NOTE_MAX_CHARS = 2_000;
/**
 * How long a report waits for the one running before it. The longest job is
 * an automatic send: the collection (8 s steps, run together) and then the
 * upload (20 s), plus the file writes around them.
 */
export const DIAGNOSTICS_QUEUE_WAIT_MS = 35_000;
/**
 * The renderer's budget for a prepare or a send: the wait above, then its own
 * collection or upload (20 s at most), with room for the writes around them.
 */
export const MANUAL_DIAGNOSTICS_IPC_TIMEOUT_MS = DIAGNOSTICS_QUEUE_WAIT_MS + 40_000;

type DiagnosticsJobKind = "auto" | "manual";

/** Settles true when `done` settles first, false when `ms` passes first. The timer never outlives the wait. */
function settlesWithin(done: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type PreparedSendAnswer = {
  result: DiagnosticsManualSendResult;
  context: ManualDiagnosticsContext | null;
  /** True for a second call that joined a send already running for the same id. */
  joined?: boolean;
  /**
   * True once this send claimed a slot in the manual ledger, so an upload was
   * tried. Absent when nothing was tried: an unknown id, a busy wait that ran
   * out, a daily limit, or a ledger that could not be read or locked.
   */
  claimed?: true;
};

type PreparedManualReport = {
  built: AutoDiagnosticsReport;
  context: ManualDiagnosticsContext;
  expiresAtMs: number;
};

export type AutoDiagnosticsReport = {
  report: string;
  filePath: string;
  installId: string;
  /** Upload metadata, so the stored report names its machine. */
  machineId?: string | null;
};

export type AutoDiagnosticsServiceDeps = {
  /** `<adeHome>/secrets/diagnostics-autosend.json`. */
  stateFilePath: string;
  buildReport: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsReport>;
  appVersion: string | null;
  /**
   * Fires once per successful send so a window that is up can toast
   * immediately. It is a fast path only: the send is recorded pending either
   * way and the renderer's acknowledgement is what actually retires it.
   */
  onSent?: (notice: AutoDiagnosticsSentNotice) => void;
  capture?: (input: ProductAnalyticsCapture) => void;
  logger?: AutoDiagnosticsLogger;
  /** A development build sends nothing on its own (`runAutoDiagnosticsSend`). */
  devBuild?: boolean;
  /**
   * Test seams. `upload` is typed by what this service needs of an answer
   * rather than as `typeof uploadDiagnosticReport`, so a test can pass a plain
   * stub instead of casting one through `as unknown as`.
   */
  env?: NodeJS.ProcessEnv;
  upload?: (request: DiagnosticUploadRequest) => Promise<AutoDiagnosticsUploadResult>;
  writeReportFile?: (filePath: string, report: string) => boolean;
  now?: () => number;
};

export type AutoDiagnosticsService = {
  /** One call per failure point. Never throws and never rejects. */
  report: (request: AutoDiagnosticsRequest) => Promise<AutoDiagnosticsOutcome>;
  /**
   * Builds and redacts one report for a person to read, and keeps it here
   * under a one-use id. Uploads nothing, writes nothing remote and claims no
   * budget. Without a context it is Settings' "Send a report to ADE"
   * (`settings_manual`); with one it is an error screen's report dialog.
   * Never throws.
   */
  prepareManual: (context?: ManualDiagnosticsContext) => Promise<DiagnosticsPrepareResult>;
  /**
   * Uploads the prepared report with this id, byte for byte, and claims the
   * manual budget then. An unknown or expired id answers `expired` and sends
   * nothing. A sent report is forgotten; a failed one stays until it expires,
   * so "Try again" sends the same text. Never throws; every outcome is named.
   * `context` is what the report was prepared for, null for an unknown id.
   * A second call for an id whose send is still running gets that send's
   * answer with `joined: true`, and nothing is uploaded or claimed twice.
   */
  sendPrepared: (id: string) => Promise<PreparedSendAnswer>;
  /** Drops a prepared report (Cancel). Unknown ids are ignored. */
  discardPrepared: (id: string) => void;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  getStatus: () => {
    enabled: boolean;
    sendsInWindow: number;
    limit: number;
    manualSendsInWindow: number;
    manualLimit: number;
  };
  /**
   * The sends no renderer has acknowledged showing yet — the brain's, and any
   * this process made while no window was listening. Read when a renderer
   * subscribes, so there is no timer behind it. Listing does NOT retire them:
   * `ackNotices` does, once the toast is on screen.
   */
  listPendingNotices: () => AutoDiagnosticsNotice[];
  /** Retires the notices a renderer has actually rendered. Idempotent. */
  ackNotices: (references: readonly string[]) => void;
};

export function createAutoDiagnosticsService(
  deps: AutoDiagnosticsServiceDeps,
): AutoDiagnosticsService {
  const now = deps.now ?? Date.now;
  const upload = deps.upload ?? uploadDiagnosticReport;
  const writeReportFile = deps.writeReportFile ?? writeDiagnosticReportFile;
  const env = deps.env ?? process.env;
  // One at a time. Two failures that fire together would otherwise race on the
  // budget file and, worse, run two report collections at once on a machine
  // that is already unwell. A job that meets a running one waits for it
  // (bounded), so a person's dialog does not fail because an automatic send is
  // running, and an automatic send is not lost to a dialog.
  let running: { kind: DiagnosticsJobKind; done: Promise<void> } | null = null;

  /**
   * Waits for the running job to end, then takes the slot. Answers the release
   * function, or null when the wait ran out or `skipWhenAutoRuns` met an
   * automatic job. Never throws.
   */
  const acquire = async (
    kind: DiagnosticsJobKind,
    options: { skipWhenAutoRuns?: boolean } = {},
  ): Promise<(() => void) | null> => {
    const deadline = Date.now() + DIAGNOSTICS_QUEUE_WAIT_MS;
    // Several waiters wake together when a job ends; the first takes the slot
    // and the others see it taken and wait again.
    while (running) {
      // Two automatic failures at once are one report, as before: the second
      // one is dropped, not queued behind the first.
      if (options.skipWhenAutoRuns && running.kind === "auto") return null;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      if (!(await settlesWithin(running.done, remainingMs))) return null;
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = { kind, done };
    running = job;
    return () => {
      if (running === job) running = null;
      release();
    };
  };

  const report = async (request: AutoDiagnosticsRequest): Promise<AutoDiagnosticsOutcome> => {
    const release = await acquire("auto", { skipWhenAutoRuns: true });
    if (!release) return "skipped_ineligible";
    try {
      return await runAutoDiagnosticsSend<AutoDiagnosticsReport>({
        stateFilePath: deps.stateFilePath,
        source: "desktop",
        analyticsSurface: "desktop",
        failureCode: request.failureCode,
        surface: request.surface,
        build: (failureCode) => deps.buildReport({ ...request, failureCode }),
        reportPathOf: (built) => (writeReportFile(built.filePath, built.report) ? built.filePath : null),
        send: async (built, failureCode) =>
          upload({
            baseUrl: resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL),
            report: built.report,
            installId: built.installId === "unknown" ? null : built.installId,
            machineId: built.machineId ?? null,
            appVersion: deps.appVersion,
            auto: true,
            failureCode,
          }),
        onSent: deps.onSent,
        logger: deps.logger,
        capture: deps.capture,
        devBuild: deps.devBuild,
        now,
      });
    } finally {
      release();
    }
  };

  /**
   * Reports a person is reading in a dialog, by id. Few and short-lived: each
   * one is a full report (up to 512 KB), and an id nobody sends is dropped
   * when it expires or when a newer one pushes it out.
   */
  const prepared = new Map<string, PreparedManualReport>();
  const dropExpired = () => {
    const at = now();
    for (const [id, entry] of prepared) {
      if (entry.expiresAtMs <= at) prepared.delete(id);
    }
  };

  /**
   * Step one of "Send a report to ADE" in Settings and of an error screen's
   * report dialog: the same collector and redaction as every other send, so
   * what the person reads is what ADE would get.
   *
   * Nothing is claimed here. Opening the dialog and pressing Cancel must cost
   * the person nothing, so the budget is spent only by `sendPrepared`.
   */
  const prepareManual = async (context?: ManualDiagnosticsContext): Promise<DiagnosticsPrepareResult> => {
    // A collection already running is not two at once on a machine that is
    // already unwell: this one waits for it. Only a wait that runs out fails,
    // and the dialog offers "Try again".
    const release = await acquire("manual");
    if (!release) return { ok: false, reason: "failed" };
    try {
      const manualContext = context ?? { surface: "settings_manual" };
      let built: AutoDiagnosticsReport;
      try {
        built = await deps.buildReport({ ...manualContext, failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE });
      } catch (error) {
        deps.logger?.warn?.("diagnostics.manual_prepare_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, reason: "failed" };
      }
      dropExpired();
      while (prepared.size >= MAX_PREPARED_REPORTS) {
        const oldest = prepared.keys().next().value;
        if (oldest === undefined) break;
        prepared.delete(oldest);
      }
      const id = randomUUID();
      const expiresAtMs = now() + PREPARED_REPORT_TTL_MS;
      prepared.set(id, { built, context: manualContext, expiresAtMs });
      return {
        ok: true,
        id,
        report: built.report,
        bytes: Buffer.byteLength(built.report, "utf8"),
        expiresAtMs,
        noteMaxChars: MANUAL_NOTE_MAX_CHARS,
      };
    } finally {
      release();
    }
  };

  /**
   * Step two: the person pressed Send on text they have read.
   *
   * The opt-out is deliberately NOT checked. It governs reports ADE files BY
   * ITSELF when something breaks; this is a person asking, about a report they
   * just read. Refusing it would leave someone who opted out of background
   * reporting with no way to send anything at all. Nothing here writes
   * `enabled`.
   *
   * It is also NOT `runAutoDiagnosticsSend`: that policy is silence on failure
   * and a pending toast, both correct for a send nobody asked for and both
   * wrong here. A user watching a button has to be told the answer, and telling
   * them twice — inline and again in a toast — is worse than once.
   */
  const sendsInProgress = new Map<string, Promise<PreparedSendAnswer>>();

  const sendPrepared = (id: string): Promise<PreparedSendAnswer> => {
    dropExpired();
    const entry = typeof id === "string" ? prepared.get(id) : undefined;
    // Never build a fresh report here: the person would be sending text they
    // have not seen. The surface prepares again and shows it.
    if (!entry) return Promise.resolve({ result: { ok: false, reason: "expired" }, context: null });
    // A second Send for a report whose send is still running gets that send's
    // answer: one upload and one budget claim, however often the button fires.
    const inProgress = sendsInProgress.get(id);
    if (inProgress) return inProgress.then((answer) => ({ ...answer, joined: true }));
    const send = sendEntry(id, entry).finally(() => {
      sendsInProgress.delete(id);
    });
    sendsInProgress.set(id, send);
    return send;
  };

  const sendEntry = async (id: string, entry: PreparedManualReport): Promise<PreparedSendAnswer> => {
    const { built, context } = entry;
    // A send waits for a running job rather than failing. A wait that runs out
    // is not a budget event: nothing is claimed, so "Try again" costs nothing.
    const release = await acquire("manual");
    if (!release) return { result: { ok: false, reason: "failed" }, context };
    try {
      // Cancel or a newer report may have dropped this one during the wait.
      if (prepared.get(id) !== entry) return { result: { ok: false, reason: "expired" }, context: null };
      const claim = claimManualDiagnosticsSend({
        filePath: deps.stateFilePath,
        source: "desktop",
        now,
      });
      if (!claim.allowed) {
        deps.logger?.info?.("diagnostics.manual_send_skipped", { reason: claim.reason });
        // A ledger that cannot be read or locked fails closed, exactly as the
        // automatic claim does — but the user gets told, rather than nothing.
        return {
          result: claim.reason === "daily_limit"
            ? { ok: false, reason: "local_limit", limit: MAX_MANUAL_DIAGNOSTICS_PER_WINDOW }
            : { ok: false, reason: "failed" },
          context,
        };
      }

      let reportPath: string | null;
      try {
        reportPath = writeReportFile(built.filePath, built.report) ? built.filePath : null;
      } catch {
        reportPath = null;
      }

      let result: AutoDiagnosticsUploadResult;
      try {
        result = await upload({
          baseUrl: resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL),
          report: built.report,
          installId: built.installId === "unknown" ? null : built.installId,
          machineId: built.machineId ?? null,
          appVersion: deps.appVersion,
          // `auto: false` is the whole point of the flag: server-side these have
          // to stay separable from the reports nobody chose to file.
          auto: false,
          failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE,
        });
      } catch {
        result = { ok: false, reason: "network" };
      }

      // The reservation stays spent either way, for the automatic sender's
      // reason: what it bounds is how often this computer tries, not how often
      // it wins.
      completeAutoDiagnosticsSend({
        filePath: deps.stateFilePath,
        failureCode: MANUAL_DIAGNOSTICS_FAILURE_CODE,
        atMs: claim.atMs,
        reportPath,
        reference: result.ok ? result.reference : null,
        // Never pending: the person who pressed the button is looking at the
        // answer. A toast on top of it would be the same news twice.
        pending: false,
        kind: "manual",
        now,
      });

      if (!result.ok) {
        deps.logger?.warn?.("diagnostics.manual_send_failed", { reason: result.reason });
        // The uploader tells the two 429s apart for us: `rate_limited` is this
        // caller's own daily allowance, `unavailable` is ADE not taking reports
        // from anyone. Those are different sentences to a user, so they stay
        // different reasons all the way to the screen.
        const reason: ManualSendFailure =
          result.reason === "rate_limited"
            ? "rate_limited"
            : result.reason === "unavailable"
              ? "unavailable"
              : result.reason === "too_large"
                ? "too_large"
                : "failed";
        return { result: { ok: false, reason, ...(reportPath ? { reportPath } : {}) }, context, claimed: true };
      }

      // One use: the same text is never stored twice under two references.
      prepared.delete(id);
      deps.logger?.info?.("diagnostics.manual_sent", { reference: result.reference });
      return { result: { ok: true, reference: result.reference, reportPath: reportPath ?? "" }, context, claimed: true };
    } finally {
      release();
    }
  };

  return {
    report,
    prepareManual,
    sendPrepared,
    discardPrepared: (id) => {
      prepared.delete(id);
    },
    isEnabled: () => isAutoDiagnosticsEnabled(deps.stateFilePath),
    setEnabled: (enabled) => setAutoDiagnosticsEnabled(deps.stateFilePath, enabled, { now }),
    getStatus: () => readAutoDiagnosticsState(deps.stateFilePath, { now }),
    listPendingNotices: () => listPendingAutoDiagnosticsNotices(deps.stateFilePath),
    ackNotices: (references) =>
      ackAutoDiagnosticsNotices(deps.stateFilePath, references, { now }),
  };
}
