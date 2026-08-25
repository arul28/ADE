/**
 * Contract for the "Report issue" flow shared by main, preload and renderer.
 *
 * The report itself is a redacted Markdown document: private paths, account
 * names, emails, addresses and tokens are stripped in the main process before
 * it ever reaches the renderer or the clipboard.
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
 * The answer to "Send a report" in Settings.
 *
 * A manual send is the one diagnostics path that must never fail silently: the
 * user asked for it and is watching. So every outcome is named, and the surface
 * turns each into one plain sentence — never a status code.
 *
 * `local_limit` is this computer's own guard (see
 * `MAX_MANUAL_DIAGNOSTICS_PER_WINDOW`); `rate_limited` is the server saying
 * this caller has stored its allowance; `unavailable` is the server saying it
 * is not taking reports from anyone right now. They are three different
 * sentences because they are three different situations.
 */
export type DiagnosticsManualSendResult =
  | {
    ok: true;
    /** Short handle to read back to support. */
    reference: string;
    /** Saved report path; empty when the local copy could not be written. */
    reportPath: string;
  }
  | {
    ok: false;
    reason:
      | "local_limit"
      | "rate_limited"
      | "unavailable"
      | "too_large"
      | "failed";
    /** The local ceiling, so the refusal can name the real number. */
    limit?: number;
    /** Saved report path when the report was built but not sent. */
    reportPath?: string;
  };

/** Main → renderer, once per automatic send. Codes and handles only. */
export type DiagnosticsAutoSentPayload = {
  failureCode: string;
  /** Saved report path; empty when the local copy could not be written. */
  reportPath: string;
  /** Short upload handle to read back to support. */
  reference: string;
};

export type DiagnosticReportPayload = {
  /** The full redacted report, ready to paste. */
  report: string;
  /** Where the report was saved on disk (empty when it could not be written). */
  filePath: string;
  /** Prefilled GitHub new-issue URL carrying only a short stub. */
  issueUrl: string;
  /** PostHog `distinct_id` for this installation, for maintainer correlation. */
  installId: string;
  /** Whether the report reached the clipboard (open-issue path only). */
  copied?: boolean;
  /** Whether the browser was actually handed the issue URL. */
  opened?: boolean;
};
