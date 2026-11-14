/**
 * Contract for the "Report this error to ADE" flow shared by main, preload and renderer.
 *
 * The report itself is a redacted Markdown document: private paths, account
 * names, emails, addresses and tokens are stripped in the main process before
 * it ever reaches the renderer, which shows it to the person before any send.
 */

/** Which error screen the report was requested from. */
export type DiagnosticSurface =
  | "project_recovery"
  | "renderer_crash"
  | "page_crash"
  | "update_transaction"
  | "brain_repair"
  | "connections"
  /** A person pressed "Send a report" in Settings, with nothing visibly broken. */
  | "settings_manual"
  | (string & {});

export type DiagnosticReportRequestPayload = {
  surface: DiagnosticSurface;
  /** The user-facing headline the screen already showed. */
  headline?: string | null;
  /** Recovery error code, when the screen has one. */
  code?: string | null;
  /** The technical text the screen already exposed behind its details fold. */
  technicalDetail?: string | null;
  projectRoot?: string | null;
  /**
   * The Sentry event of the crash the screen shows, when it was captured. The
   * web client links its report to it; the desktop main process ignores it.
   */
  sentryEventId?: string | null;
};

/**
 * "Share diagnostics with ADE when something breaks", as the renderer sees it.
 *
 * Default on. The same flag gates the brain's own automatic sends, because both
 * read one file — see `main/services/diagnostics/autoDiagnosticsStore.ts`.
 */
export type DiagnosticsSharingStatus = {
  enabled: boolean;
  /** Automatic reports already sent in the last 24 hours. */
  sendsInWindow: number;
  /** The daily ceiling those are counted against. */
  limit: number;
  /** Reports the user asked for by hand in the last 24 hours. Separate budget. */
  manualSendsInWindow?: number;
  /** The daily ceiling THOSE are counted against. */
  manualLimit?: number;
};

/**
 * Extra input to a manual send that is not part of the report itself.
 * `userMessage` is the person's own description: it goes to Sentry as User
 * Feedback (scrubbed, at most 2,000 characters), never into the R2 report or
 * PostHog, and only where Sentry runs.
 */
export type DiagnosticsManualSendOptions = {
  userMessage?: string | null;
};

/**
 * A report built and redacted for a person to read before it goes anywhere.
 *
 * Preparing sends nothing and spends none of the daily report budget. `id` is
 * opaque and good for one successful send: `sendReport(id)` uploads exactly
 * `report`, byte for byte. It expires (`expiresAtMs`) and is dropped on
 * Cancel; a send with an unknown or expired id answers `expired` and uploads
 * nothing, so the surface builds a new one and shows it again.
 */
export type DiagnosticsPreparedReport = {
  id: string;
  /** The exact text that `sendReport(id)` uploads. */
  report: string;
  /** UTF-8 size of `report`. */
  bytes: number;
  expiresAtMs: number;
  /**
   * Longest note this send can carry. 2,000 on desktop; on the web client the
   * note and the report share one 2,000-character Sentry note, so it is what
   * the report leaves.
   */
  noteMaxChars: number;
};

export type DiagnosticsPrepareResult =
  | ({ ok: true } & DiagnosticsPreparedReport)
  | { ok: false; reason: "failed" };

/**
 * The answer to sending a prepared report: from an error screen's "Report this
 * error to ADE…" dialog, or Settings' "Send a report".
 *
 * A manual send is the one diagnostics path that must never fail silently: the
 * user asked for it and is watching. So every outcome is named, and the surface
 * turns each into one plain sentence — never a status code.
 *
 * `local_limit` is this computer's own guard (see
 * `MAX_MANUAL_DIAGNOSTICS_PER_WINDOW`); `rate_limited` is the server saying
 * this caller has stored its allowance; `unavailable` is the server saying it
 * is not taking reports from anyone right now. They are three different
 * sentences because they are three different situations. `expired` is a
 * prepared report this process no longer holds (too old, cancelled, or already
 * sent): nothing was uploaded and no budget was spent.
 */
export type DiagnosticsManualSendResult =
  | {
    ok: true;
    /** Short handle to read back to support. */
    reference: string;
    /** Saved report path; empty when the local copy could not be written. */
    reportPath: string;
    /** The redacted report that was sent. */
    report?: string;
    /**
     * A prefilled public GitHub new-issue link that holds only the reference,
     * the ADE version and channel and the OS family (`buildPublicIssueUrl`).
     */
    publicIssueUrl?: string;
  }
  | {
    ok: false;
    reason:
      | "local_limit"
      | "rate_limited"
      | "unavailable"
      | "too_large"
      | "expired"
      | "failed";
    /** The local ceiling, so the refusal can name the real number. */
    limit?: number;
    /** Saved report path when the report was built but not sent. */
    reportPath?: string;
    /** The redacted report, when it was built but not sent. */
    report?: string;
  };

/** Main → renderer, once per automatic send. Codes and handles only. */
export type DiagnosticsAutoSentPayload = {
  failureCode: string;
  /** Saved report path; empty when the local copy could not be written. */
  reportPath: string;
  /** Short upload handle to read back to support. */
  reference: string;
};
