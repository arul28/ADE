import { useEffect, useState, type ReactNode } from "react";
import { Desktop } from "@phosphor-icons/react";
import { Banner, type NoticeAction } from "../ui/notice";

/**
 * What the App Control pane's one strip says right now.
 *
 * The same inline banner as the Mac Desktop and Apple panes: one thing at a
 * time, most pressing first, and each line carries the button that answers it.
 * A live, quiet session has no line at all; the toolbar's dot says "live".
 */
export type AppControlStripMessage = {
  /** Changes when the message does, so a Details disclosure closes with it. */
  key: string;
  tone: "error" | "warning" | "notice";
  sentence: string;
  /** The raw text behind the sentence, folded behind Details. */
  detail?: string | null;
  /** A glyph for a notice line. Error lines use the banner's own. */
  icon?: ReactNode;
  /** Work in flight: the banner draws its spinner. */
  busy?: boolean;
  actions?: Array<{
    label: string;
    onClick: () => void;
    disabled?: boolean;
    muted?: boolean;
  }>;
  onDismiss?: () => void;
  testId: string;
};

export function AppControlStatusStrip({ message }: { message: AppControlStripMessage | null }) {
  const [open, setOpen] = useState(false);
  const key = message?.key ?? null;
  useEffect(() => {
    setOpen(false);
  }, [key]);
  if (!message) return null;
  const detail = message.detail?.trim() || null;
  const actions: NoticeAction[] = (message.actions ?? []).map((action) => ({
    label: action.label,
    onClick: action.onClick,
    disabled: action.disabled,
    variant: action.muted ? "secondary" : undefined,
  }));
  if (detail) {
    actions.push({
      label: "Details",
      variant: "link",
      expanded: open,
      onClick: () => setOpen((value) => !value),
    });
  }
  const notice = message.tone === "notice";
  return (
    <Banner
      layout="inline"
      style={{ margin: "6px 8px", flexShrink: 0 }}
      testId={message.testId}
      model={{
        id: message.testId,
        tone: message.tone === "notice" ? "neutral" : message.tone,
        icon: notice ? message.icon ?? <Desktop size={13} /> : undefined,
        title: message.sentence,
        busy: message.busy,
        actions,
        dismiss: message.onDismiss
          ? { onDismiss: message.onDismiss, title: "Dismiss this message", label: "Dismiss" }
          : undefined,
        extra: open && detail ? (
          <div
            style={{
              maxHeight: 96,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: 11,
              lineHeight: 1.45,
              color: "var(--color-muted-fg)",
            }}
          >
            {detail}
          </div>
        ) : undefined,
      }}
    />
  );
}
