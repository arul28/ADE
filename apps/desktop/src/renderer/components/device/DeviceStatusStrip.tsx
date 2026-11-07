import { useState, type ReactNode } from "react";
import { Banner, type NoticeAction, type NoticeReport } from "../ui/notice";
import type { DeviceToolId } from "./deviceTool";

/**
 * The strips at the top of a device pane: one line, one action, and the raw
 * text folded behind `Details`.
 *
 * §6: no toasts, no `String(error)` in JSX, and no sentence longer than twelve
 * words. Each tool's error mapping owns the words; this owns where they sit.
 * `Details` is a disclosure rather than a second line because the wire text is
 * for the one person in a hundred who is going to paste it into an issue, and
 * it is always the longest thing on screen.
 *
 * `tool` names the `data-{tool}-status-strip` marker and the banner's id.
 * `report` names the failure for Sentry and the issue report (a stable code
 * and the raw text); without it the banner reports its own words.
 */
export function DeviceErrorStrip({
  tool,
  sentence,
  detail,
  actions,
  onDismiss,
  report,
}: {
  tool: DeviceToolId;
  sentence: string;
  detail?: string | null | undefined;
  actions?: NoticeAction[] | undefined;
  onDismiss?: (() => void) | undefined;
  report?: NoticeReport | undefined;
}) {
  const [open, setOpen] = useState(false);
  const all: NoticeAction[] = [...(actions ?? [])];
  if (detail) {
    all.push({ label: "Details", variant: "link", expanded: open, onClick: () => setOpen((value) => !value) });
  }
  return (
    <div {...{ [`data-${tool}-status-strip`]: "error" }} style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: `${tool}-device-status`,
          tone: "error",
          title: sentence,
          actions: all,
          dismiss: onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
          ...(report ? { report } : {}),
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
    </div>
  );
}

/**
 * A fact about the device, not a failure: "iPhone 17 Pro is off." or
 * "Video stopped." It gets the same one line and the same one button without
 * the red.
 */
export function DeviceNoticeStrip({
  tool,
  icon,
  sentence,
  tone = "neutral",
  actions,
  onDismiss,
  busy,
}: {
  tool: DeviceToolId;
  icon: ReactNode;
  sentence: string;
  tone?: "neutral" | "warning";
  actions: NoticeAction[];
  onDismiss?: (() => void) | undefined;
  /** The action is running: the icon spins and the action is not offered twice. */
  busy?: boolean | undefined;
}) {
  return (
    <div {...{ [`data-${tool}-status-strip`]: tone === "warning" ? "warning" : "notice" }} style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: `${tool}-device-notice`,
          tone,
          icon,
          title: sentence,
          actions: busy ? [] : actions,
          busy: busy ?? false,
          dismiss: onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
        }}
      />
    </div>
  );
}
