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
 * through the same callback — is acknowledged once its toast has been COMMITTED
 * to the screen, not merely queued. `showToast` returns before React has
 * rendered anything, so acknowledging there would claim delivery for a window
 * that could still die before the toast appeared; `onRendered` fires from
 * `ToastStack`'s own effect instead. Main keeps offering anything
 * unacknowledged, so a window that dies mid-render repeats one toast rather
 * than swallowing it, and a window that rendered it never sees it again on the
 * next launch.
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
            // `ToastStack` dismisses this toast the moment the click returns,
            // so a write that did not land would otherwise leave the user
            // believing they turned auto-send off while it is still on. This is
            // a consent control: it says so instead. `setSharing` answers with
            // what was actually persisted, which is how a refused write shows
            // up here — it resolves still-enabled rather than rejecting.
            void bridge
              .setSharing(false)
              .then((status) => {
                if (status?.enabled !== false) throw new Error("not_saved");
              })
              .catch(() => {
                showToast({
                  title: "ADE could not turn this off",
                  message: "Try again in Settings → General.",
                  tone: "error",
                });
              });
          },
        },
        // The ack is the claim that the toast EXISTS, so it waits for the
        // commit rather than firing beside the queueing call. Un-referenced
        // notices cannot be acknowledged (nothing to name them by), but they
        // also cannot occur — `pending` is only set alongside a successful
        // upload, and a successful upload always carries a reference.
        ...(reference
          ? {
              onRendered: () => {
                void bridge.ackAutoSent([reference]).catch(() => undefined);
              },
            }
          : {}),
      });
    });
  }, []);
}
