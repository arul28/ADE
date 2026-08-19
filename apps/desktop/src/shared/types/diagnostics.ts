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
