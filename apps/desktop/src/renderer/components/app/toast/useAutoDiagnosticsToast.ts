import { useEffect } from "react";
import { showToast } from "./toastStore";

/**
 * One toast per automatic diagnostic report.
 *
 * Auto-send only stays acceptable if it is never invisible: something left this
 * computer, and the person it belongs to gets told, every time, with the two
 * things they might want next — the report itself, and the off switch.
 *
 * Subscribing is also what releases reports the brain sent while no window was
 * open, so a headless send surfaces the next time ADE is on screen instead of
 * being silently dropped.
 */
export function useAutoDiagnosticsToast(): void {
  useEffect(() => {
    const bridge = window.ade?.diagnostics;
    if (!bridge?.onAutoSent) return;
    return bridge.onAutoSent((payload) => {
      const reportPath = payload.reportPath?.trim() || "";
      showToast({
        // Per report rather than per failure: two different failures in a day
        // are two different things the user was told about.
        id: `diagnostics-auto-sent-${payload.reference || payload.failureCode}`,
        title: "A diagnostic report was sent to ADE",
        message: payload.reference ? `Reference ${payload.reference}` : undefined,
        tone: "info",
        durationMs: 10_000,
        ...(reportPath
          ? {
              action: {
                label: "View",
                onClick: () => {
                  void window.ade?.diagnostics?.revealReport?.(reportPath).catch(() => undefined);
                },
              },
            }
          : {}),
        secondaryAction: {
          label: "Turn off",
          onClick: () => {
            void window.ade?.diagnostics?.setSharing?.(false).catch(() => undefined);
          },
        },
      });
    });
  }, []);
}
