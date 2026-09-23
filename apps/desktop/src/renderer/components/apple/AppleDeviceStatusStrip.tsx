import { useState, type ReactNode } from "react";
import { ToolStatusStrip, ToolStatusStripAction } from "../shared/ToolStatusStrip";
import {
  describeAppleError,
  type AppleErrorAction,
  type AppleErrorDescription,
} from "./appleErrors";

export { describeAppleError };
export type { AppleErrorAction, AppleErrorDescription };

const ACTION_LABEL = {
  start: "Start",
  reconnect: "Reconnect",
  reinstall: "How to fix",
} as const;

/**
 * One line at the top of the pane, and the raw text folded behind `Details`.
 *
 * §6: no toasts, no `String(error)` in JSX, and no sentence longer than twelve
 * words. The mapping owns the words; this owns where they sit. `Details` is a
 * disclosure rather than a second line because the wire text is for the one
 * person in a hundred who is going to paste it into an issue, and it is always
 * the longest thing on screen.
 */
export function AppleDeviceStatusStrip({
  error,
  onAction,
  onDismiss,
}: {
  /** The raw failure. Never rendered; only `describeAppleError` reads it. */
  error: unknown;
  onAction?: ((action: AppleErrorAction) => void) | undefined;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const described = describeAppleError(error);
  const action = described.action;
  return (
    <StripShell
      tone="error"
      sentence={described.sentence}
      onDismiss={onDismiss}
      detail={open && described.detail ? described.detail : null}
      actions={(
        <>
          {action && onAction ? (
            <StripAction label={ACTION_LABEL[action]} onClick={() => onAction(action)} />
          ) : null}
          {described.detail ? (
            <StripAction
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

/**
 * The two strips §3 asks for that are not failures: "iPhone 17 Pro is off." and
 * "Video stopped." A dead device is a fact about the device, not an error the
 * user caused, so it gets the same one line and the same one button without
 * the red.
 *
 * A strip may carry ONE quieter second choice after the first — "is off." has
 * two honest answers, turn it back on or pick another device, and a person
 * should not have to find the second one in the rail's overflow menu.
 */
export function AppleDeviceNoticeStrip({
  sentence,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  onDismiss,
}: {
  sentence: string;
  actionLabel: string;
  onAction: () => void;
  secondaryActionLabel?: string | undefined;
  onSecondaryAction?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <StripShell
      tone="notice"
      sentence={sentence}
      detail={null}
      onDismiss={onDismiss}
      actions={(
        <>
          <StripAction label={actionLabel} onClick={onAction} />
          {secondaryActionLabel && onSecondaryAction ? (
            <StripAction label={secondaryActionLabel} muted onClick={onSecondaryAction} />
          ) : null}
        </>
      )}
    />
  );
}

/** The shell is shared with the Mac Desktop pane; this keeps Apple's marker. */
function StripShell(props: {
  tone: "error" | "notice";
  sentence: string;
  detail: string | null;
  actions: ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  return <ToolStatusStrip {...props} marker={{ "data-apple-status-strip": props.tone }} />;
}

const StripAction = ToolStatusStripAction;
