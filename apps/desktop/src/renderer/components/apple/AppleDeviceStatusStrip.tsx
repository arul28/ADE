import { AppleLogo } from "../ui/appleIcons";
import type { NoticeAction } from "../ui/notice";
import { DeviceErrorStrip, DeviceNoticeStrip } from "../device/DeviceStatusStrip";
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

/** One line at the top of the pane, and the raw text folded behind `Details`. */
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
  const described = describeAppleError(error);
  const action = described.action;
  const actions: NoticeAction[] = [];
  if (action && onAction) {
    actions.push({ label: ACTION_LABEL[action], onClick: () => onAction(action) });
  }
  return (
    <DeviceErrorStrip
      tool="apple"
      sentence={described.sentence}
      detail={described.detail}
      actions={actions}
      onDismiss={onDismiss}
    />
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
  busy,
}: {
  sentence: string;
  actionLabel: string;
  onAction: () => void;
  secondaryActionLabel?: string | undefined;
  onSecondaryAction?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  /** The action is running: the icon spins and the action is not offered twice. */
  busy?: boolean | undefined;
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
    <DeviceNoticeStrip
      tool="apple"
      icon={<AppleLogo size={13} />}
      sentence={sentence}
      actions={actions}
      onDismiss={onDismiss}
      busy={busy}
    />
  );
}
