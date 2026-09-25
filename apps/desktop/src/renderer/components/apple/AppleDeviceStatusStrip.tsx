import { useState } from "react";
import { AppleLogo } from "../ui/appleIcons";
import { Banner, type NoticeAction } from "../ui/notice";
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
  const actions: NoticeAction[] = [];
  if (action && onAction) {
    actions.push({ label: ACTION_LABEL[action], onClick: () => onAction(action) });
  }
  if (described.detail) {
    actions.push({
      label: "Details",
      variant: "link",
      expanded: open,
      onClick: () => setOpen((value) => !value),
    });
  }
  return (
    <div data-apple-status-strip="error" style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: "apple-device-status",
          tone: "error",
          title: described.sentence,
          actions,
          dismiss: { onDismiss, title: "Dismiss this message", label: "Dismiss this message" },
          extra: open && described.detail ? (
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
              {described.detail}
            </div>
          ) : undefined,
        }}
      />
    </div>
  );
}

/**
 * The two strips §3 asks for that are not failures: "iPhone 17 Pro is off." and
 * "Video stopped." A dead device is a fact about the device, not an error the
 * user caused, so it gets the same one line and the same one button without
 * the red.
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
  const actions: NoticeAction[] = [{ label: actionLabel, onClick: onAction }];
  if (secondaryActionLabel && onSecondaryAction) {
    actions.push({
      label: secondaryActionLabel,
      variant: "secondary",
      onClick: onSecondaryAction,
    });
  }
  return (
    <div data-apple-status-strip="notice" style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: "apple-device-notice",
          tone: "neutral",
          icon: <AppleLogo size={13} />,
          title: sentence,
          actions,
          dismiss: onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
        }}
      />
    </div>
  );
}
