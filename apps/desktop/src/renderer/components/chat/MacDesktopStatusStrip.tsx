import { useEffect, useState } from "react";
import { Desktop } from "@phosphor-icons/react";
import { Banner, type NoticeAction } from "../ui/notice";

/**
 * What the pane's one strip says right now.
 *
 * The pane used to stack amber lines above the picture — a permission banner,
 * an input refusal, a recording refusal — plus a sentence painted on the
 * picture itself when the video dropped, with no way to ask for it back. It
 * says one thing at a time now, in the same inline banner as the Apple pane's
 * strip, and the thing it says carries the button that fixes it.
 */
export type MacDesktopStripMessage = {
  /** Changes when the message does, so a Details disclosure closes with it. */
  key: string;
  tone: "error" | "notice";
  sentence: string;
  /** The raw text behind the sentence, folded behind Details. */
  detail?: string | null;
  actions?: Array<{
    label: string;
    onClick: () => void;
    disabled?: boolean;
    muted?: boolean;
  }>;
  onDismiss?: () => void;
  testId: string;
};

export function MacDesktopStatusStrip({
  message,
  suffix,
}: {
  message: MacDesktopStripMessage | null;
  /** The pane draws no suffix; full screen draws `-fs`. */
  suffix: string;
}) {
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
  const error = message.tone === "error";
  return (
    <Banner
      layout="inline"
      style={{ margin: "6px 8px", flexShrink: 0 }}
      testId={`${message.testId}${suffix}`}
      model={{
        id: message.testId,
        tone: error ? "error" : "neutral",
        icon: error ? undefined : <Desktop size={13} />,
        title: message.sentence,
        actions,
        dismiss: message.onDismiss
          ? { onDismiss: message.onDismiss, title: "Dismiss this message", label: "Dismiss this message" }
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
