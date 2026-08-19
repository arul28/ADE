import type {
  ProductAnalyticsCapture,
  ProductAnalyticsSurface,
} from "../../../shared/types/productAnalytics";
import {
  claimAutoDiagnosticsSend,
  completeAutoDiagnosticsSend,
  isAutoDiagnosticsEnabled,
  normalizeAutoDiagnosticsFailureCode,
  type AutoDiagnosticsSource,
} from "./autoDiagnosticsStore";

/**
 * The policy every automatic diagnostic send obeys, written once.
 *
 * There are two senders — the desktop main process and the brain — and they
 * differ in exactly three ways: what they build, how they upload it, and which
 * analytics surface they report as. Everything else (consent, the reservation,
 * the local copy, silence on failure, the pending flag, the log lines, the
 * dedupe key) is a promise made to the user, and a promise kept in two places
 * is a promise that will eventually be kept in one. So the senders bring the
 * three differences and this brings the policy.
 *
 * The seams are STRUCTURAL — `build` and `send` are typed over what they
 * actually return, not over one sender's concrete functions — so a test can
 * hand in an ordinary object instead of casting a fake through `as never`.
 */

/** One hour, so a machine failing repeatedly does not narrate every attempt. */
export const AUTO_DIAGNOSTICS_ANALYTICS_DEDUPE_MS = 60 * 60 * 1_000;

export type AutoDiagnosticsOutcome =
  /** Sent, and the ledger has a pending notice for it. */
  | "completed"
  /** Consent is withdrawn. Nothing was built, sent, or counted. */
  | "skipped_disabled"
  /**
   * The reservation was refused: the code's daily slot or the install's three
   * are gone, or the ledger could not be read or locked and so fails closed.
   */
  | "skipped_budget"
  /**
   * The request never became a candidate: an unusable failure code, or another
   * send already in flight. Distinct from `skipped_budget` because nothing was
   * spent and nothing was refused — and, like today, it emits no analytics.
   */
  | "skipped_ineligible"
  /** Built or uploaded and did not work. Silent to the user by design. */
  | "failed";

export type AutoDiagnosticsLogger = {
  info?: (event: string, meta?: Record<string, unknown>) => void;
  warn?: (event: string, meta?: Record<string, unknown>) => void;
};

export type AutoDiagnosticsSentNotice = {
  failureCode: string;
  /** Empty when the local copy could not be written; the toast hides "View". */
  reportPath: string;
  reference: string;
};

/**
 * Structural shape of an upload answer. Both senders' concrete result types are
 * assignable to it, and neither has to be imported here.
 */
export type AutoDiagnosticsUploadResult =
  | { ok: true; reference: string }
  | { ok: false; reason: string };

export type AutoDiagnosticsSendArgs<TBuilt> = {
  /** `<adeHome>/secrets/diagnostics-autosend.json`. */
  stateFilePath: string;
  source: AutoDiagnosticsSource;
  /** `desktop` for the app, `api` for the brain — a headless send is not a person. */
  analyticsSurface: ProductAnalyticsSurface;
  /** Raw code from the trigger; normalized here. */
  failureCode: string;
  /** Which screen or subsystem produced it; matches the manual surfaces. */
  surface: string;
  build: (failureCode: string) => TBuilt | Promise<TBuilt>;
  /**
   * Saves the local copy and answers with its path, or `null` when it could not
   * be written. Called before the upload on purpose: the local copy is the half
   * of this the user can always still get to, so it must not depend on the
   * network half working.
   */
  reportPathOf: (built: TBuilt) => string | null;
  send: (built: TBuilt, failureCode: string) => Promise<AutoDiagnosticsUploadResult>;
  /**
   * Fast path to a toast for a send that happened while a window was up. It is
   * an optimization and NOT the record of delivery — see `pending` below.
   */
  onSent?: (notice: AutoDiagnosticsSentNotice) => void;
  logger?: AutoDiagnosticsLogger;
  capture?: (input: ProductAnalyticsCapture) => void;
  now?: () => number;
};

/**
 * Runs one automatic send. Never throws and never rejects.
 *
 * PENDING IS ALWAYS TRUE ON SUCCESS, for both senders, and that is the single
 * definition of the flag. It used to derive from whether `onSent` claimed the
 * toast was delivered, which cannot be known: `webContents.send` does not throw
 * when the receiving renderer has crashed or has not mounted its toast host, so
 * "a window existed" was being recorded as "the user was told". A send is
 * therefore left pending until a renderer actually drains it
 * (`IPC.diagnosticsFlushAutoSent`), and the fast-path `onSent` above may deliver
 * the same notice first — safe, because the renderer keys the toast on
 * `diagnostics-auto-sent-${reference}` and a repeat replaces it in place.
 */
export async function runAutoDiagnosticsSend<TBuilt>(
  args: AutoDiagnosticsSendArgs<TBuilt>,
): Promise<AutoDiagnosticsOutcome> {
  const now = args.now ?? Date.now;
  const failureCode = normalizeAutoDiagnosticsFailureCode(args.failureCode);
  if (!failureCode) return "skipped_ineligible";

  const captureOutcome = (outcome: "completed" | "skipped_budget" | "failed"): void => {
    try {
      args.capture?.({
        event: "ade_feature_used",
        surface: args.analyticsSurface,
        properties: { feature: "connections", action: "auto_sent", outcome },
        projectId: null,
        dedupeKey: `diagnostics_auto_sent:${outcome}`,
        minimumIntervalMs: AUTO_DIAGNOSTICS_ANALYTICS_DEDUPE_MS,
      });
    } catch {
      // Analytics must never change what the diagnostics path does.
    }
  };

  if (!isAutoDiagnosticsEnabled(args.stateFilePath)) return "skipped_disabled";
  const claim = claimAutoDiagnosticsSend({
    filePath: args.stateFilePath,
    failureCode,
    source: args.source,
    now,
  });
  if (!claim.allowed) {
    args.logger?.info?.("diagnostics.auto_send_skipped", {
      failureCode,
      surface: args.surface,
      reason: claim.reason,
    });
    // Consent withdrawn is not a budget event and is not worth an event of its
    // own either: nothing goes when the user has said no, including telemetry.
    if (claim.reason !== "disabled") captureOutcome("skipped_budget");
    return claim.reason === "disabled" ? "skipped_disabled" : "skipped_budget";
  }

  let built: TBuilt;
  try {
    built = await args.build(failureCode);
  } catch (error) {
    args.logger?.warn?.("diagnostics.auto_send_build_failed", {
      failureCode,
      error: error instanceof Error ? error.message : String(error),
    });
    // The reservation is deliberately NOT given back. What the budget bounds is
    // how often this computer tries on its own, and a collector that wedges
    // every time would otherwise retry forever.
    captureOutcome("failed");
    return "failed";
  }

  let reportPath: string | null;
  try {
    reportPath = args.reportPathOf(built);
  } catch {
    reportPath = null;
  }

  let result: AutoDiagnosticsUploadResult;
  try {
    result = await args.send(built, failureCode);
  } catch {
    result = { ok: false, reason: "network" };
  }

  // Recorded before the toast, so the durable half never depends on the
  // cosmetic half.
  completeAutoDiagnosticsSend({
    filePath: args.stateFilePath,
    failureCode,
    atMs: claim.atMs,
    reportPath,
    reference: result.ok ? result.reference : null,
    pending: result.ok,
    now,
  });

  if (!result.ok) {
    // Every failure is the same failure here, including a 429 from either the
    // per-user or the fleet budget: the send does not happen, the log records
    // why, and nothing reaches the screen. There is no retry — the reservation
    // is already spent, which is what keeps a server saying no from turning
    // into a machine asking repeatedly.
    args.logger?.warn?.("diagnostics.auto_send_failed", {
      failureCode,
      surface: args.surface,
      reason: result.reason,
    });
    captureOutcome("failed");
    return "failed";
  }

  try {
    args.onSent?.({ failureCode, reportPath: reportPath ?? "", reference: result.reference });
  } catch {
    // A broken listener must not turn a successful send into a failure.
  }
  args.logger?.info?.("diagnostics.auto_sent", {
    failureCode,
    surface: args.surface,
    reference: result.reference,
  });
  captureOutcome("completed");
  return "completed";
}
