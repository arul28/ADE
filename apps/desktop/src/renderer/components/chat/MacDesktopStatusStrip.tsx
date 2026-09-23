import { useEffect, useState } from "react";
import { ToolStatusStrip, ToolStatusStripAction } from "../shared/ToolStatusStrip";

/**
 * What the pane's one strip says right now.
 *
 * The pane used to stack amber lines above the picture — a permission banner,
 * an input refusal, a recording refusal — plus a sentence painted on the
 * picture itself when the video dropped, with no way to ask for it back. It
 * says one thing at a time now, in the Apple pane's strip, and the thing it
 * says carries the button that fixes it.
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
  return (
    <ToolStatusStrip
      marker={{ "data-testid": `${message.testId}${suffix}` }}
      tone={message.tone}
      sentence={message.sentence}
      detail={open ? detail : null}
      onDismiss={message.onDismiss}
      actions={(
        <>
          {(message.actions ?? []).map((action) => (
            <ToolStatusStripAction
              key={action.label}
              label={action.label}
              muted={action.muted}
              disabled={action.disabled}
              onClick={action.onClick}
            />
          ))}
          {detail ? (
            <ToolStatusStripAction
              label="Details"
              expanded={open}
              muted
              onClick={() => setOpen((value) => !value)}
            />
          ) : null}
        </>
      )}
    />
  );
}
