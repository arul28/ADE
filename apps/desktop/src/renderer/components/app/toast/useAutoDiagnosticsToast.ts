import { useEffect } from "react";
import { showToast } from "./toastStore";

/**
 * One toast per automatic diagnostic report.
 *
 * Auto-send only stays acceptable if it is never invisible: something left this
 * computer, and the person it belongs to gets told, every time, with the two
 * things they might want next — the report itself, and the off switch.
 *
 * Subscribing is also what asks for reports the brain sent while no window was
 * open, so a headless send surfaces the next time ADE is on screen instead of
 * being silently dropped.
 *
 * And this hook is the only thing that can honestly say a send was shown, so it
 * says it: every notice — live fast path or replayed on subscribe, they arrive
 * through the same callback — is acknowledged once its toast exists. Main keeps
 * offering anything unacknowledged, so a window that dies mid-render repeats
 * one toast rather than swallowing it, and a window that rendered it never sees
 * it again on the next launch.
 */
export function useAutoDiagnosticsToast(): void {
  useEffect(() => {
    const bridge = window.ade?.diagnostics;
    if (!bridge) return;
    return bridge.onAutoSent((payload) => {
      const reportPath = payload.reportPath?.trim() || "";
      const reference = payload.reference?.trim() || "";
      showToast({
        // Per report rather than per failure: two different failures in a day
        // are two different things the user was told about.
        id: `diagnostics-auto-sent-${reference || payload.failureCode}`,
        title: "A diagnostic report was sent to ADE",
        message: reference ? `Reference ${reference}` : undefined,
        tone: "info",
        durationMs: 10_000,
        ...(reportPath
          ? {
              action: {
                label: "View",
                onClick: () => {
                  void bridge.revealReport(reportPath).catch(() => undefined);
                },
              },
            }
          : {}),
        secondaryAction: {
          label: "Turn off",
          onClick: () => {
            void bridge.setSharing(false).catch(() => undefined);
          },
        },
      });
      // After the toast, never before: the ack is the claim that it exists.
      // Un-referenced notices cannot be acknowledged (nothing to name them by),
      // but they also cannot occur — `pending` is only set alongside a
      // successful upload, and a successful upload always carries a reference.
      if (reference) {
        void bridge.ackAutoSent([reference]).catch(() => undefined);
      }
    });
  }, []);
}
