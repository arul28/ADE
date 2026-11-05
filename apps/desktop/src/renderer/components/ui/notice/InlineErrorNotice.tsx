import { useState, type CSSProperties } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import { NoticeButton } from "./NoticeParts";
import { NoticePopover } from "./NoticePopover";
import { useNoticeFailure, type NoticeReport } from "./NoticeReport";
import { noticeTone } from "./noticeTones";

/**
 * The failure template, one line tall, for rows a banner would break (a
 * toolbar, a header, a chip). Same parts as a failure `Banner`, folded: the
 * message cut to fit, and a click on it opens the full error with "Report
 * issue"; a × when the owner can clear it; one Sentry signal when it shows.
 *
 *   <InlineErrorNotice id="lane-branch-switch" message={error} onDismiss={() => setError(null)} />
 */
export function InlineErrorNotice({
  id,
  message,
  label,
  report,
  onDismiss,
  size = 11,
  maxWidth,
  style,
}: {
  /** Stable name of this failure; the report's surface unless `report` names one. */
  id: string;
  /** The full error. */
  message: string;
  /** What the row shows instead of the message ("Failed"); the message is still in the panel. */
  label?: string;
  /**
   * `false` for a line that is not ADE's failure (the person has local
   * changes, the clipboard refused): amber, no "Report", no Sentry log.
   */
  report?: (Omit<NoticeReport, "headline"> & { headline?: string | null }) | false;
  onDismiss?: () => void;
  size?: number;
  maxWidth?: number | string;
  style?: CSSProperties;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // The panel shows the whole message itself, so the body is only the send result.
  const failure = useNoticeFailure({
    report: report === false ? false : { surface: id, technicalDetail: message, ...report },
    tone: report === false ? "warning" : "error",
    id,
    title: message,
  });
  const color = noticeTone(report === false ? "warning" : "error").text;

  return (
    <span
      role={report === false ? "status" : "alert"}
      data-notice-tone={report === false ? "warning" : "error"}
      data-notice-id={id}
      data-ph-unmask=""
      className="inline-flex min-w-0 items-center gap-1"
      style={{ fontSize: size, color, maxWidth, ...style }}
    >
      <NoticePopover
        open={open}
        onOpenChange={setOpen}
        width={320}
        unmask
        trigger={(
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1 rounded px-0.5 text-left hover:bg-fg/[0.06]"
            style={{ color }}
            title="Show the full error"
          >
            <WarningCircle size={size - 1} weight="fill" className="shrink-0" />
            <span className="truncate">{label ?? message}</span>
          </button>
        )}
      >
        <div className="flex items-start gap-1.5">
          <WarningCircle size={13} weight="fill" className="mt-[2px] shrink-0" style={{ color }} />
          <span className="text-[12px] font-semibold leading-snug text-fg">{failure.report?.headline ?? message}</span>
        </div>
        {/* With no report the message is the headline; it is not repeated. */}
        {failure.report ? <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-fg/[0.04] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-fg/70 select-text">
          {message}
        </pre> : null}
        {failure.action || failure.body ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{failure.body}</div>
            {failure.action ? <NoticeButton action={failure.action} tone="error" /> : null}
          </div>
        ) : null}
      </NoticePopover>
      {onDismiss ? (
        <button
          type="button"
          className="shrink-0 rounded p-0.5 opacity-70 hover:bg-fg/[0.06] hover:opacity-100"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={size - 2} />
        </button>
      ) : null}
    </span>
  );
}
