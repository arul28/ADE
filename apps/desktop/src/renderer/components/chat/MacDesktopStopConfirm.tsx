import { useSyncExternalStore } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import { Dialog } from "../ui/dialog/Dialog";
import { macDesktopStatusKey, publishMacDesktopStatus, withMacDesktopTimeout } from "./macDesktopStatusStore";

/**
 * "Stop Mac Desktop?", the question closing the Mac Desktop TAB asks.
 *
 * Closing the tab stops the lane's display, quits the apps it opened, and
 * sends the windows it borrowed back to the main screen. The Apple tab asks
 * before it powers a simulator off; this tab did not ask at all, so a stray
 * click on × ended the display with no warning.
 *
 * Three answers, not two. Unlike a simulator, a display is cheap to keep, and
 * an agent may still be using it, so "Keep running" closes the tab and leaves
 * the display up. Escape, or a click outside, is Cancel: the tab stays.
 *
 * The same shape as `AppleShutdownConfirm`: an imperative promise, because the
 * caller is `closeTool` inside a hook with no JSX of its own, and one host
 * mounted per Work page.
 */

export type MacDesktopCloseAnswer = "stop" | "keep" | "cancel";

export type MacDesktopStopConfirmRequest = {
  resolve: (answer: MacDesktopCloseAnswer) => void;
};

let pending: MacDesktopStopConfirmRequest | null = null;
let listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function settle(answer: MacDesktopCloseAnswer): void {
  const request = pending;
  pending = null;
  emit();
  request?.resolve(answer);
}

export function getMacDesktopStopConfirmRequest(): MacDesktopStopConfirmRequest | null {
  return pending;
}

/**
 * Ask, and resolve with the answer. A second ask while one is on screen
 * resolves "cancel": the safe reading of "I could not ask" is "change nothing".
 */
export function askMacDesktopStopConfirm(): Promise<MacDesktopCloseAnswer> {
  if (pending) return Promise.resolve("cancel");
  return new Promise<MacDesktopCloseAnswer>((resolve) => {
    pending = { resolve };
    emit();
  });
}

/**
 * What closing the Mac Desktop tab should do, asking first when a display runs.
 *
 * Resolves "stop" with no dialog when there is no lane, no API, or no display:
 * the stop then costs nothing. A status read that fails or does not answer
 * also resolves "stop". The display may be wedged, and closing the tab is one
 * of the ways out of that, so it must not be the step that hangs.
 */
export async function confirmMacDesktopToolClose(args: {
  laneId: string | null;
  chatSessionId?: string | null;
  runtimePin?: OpenProjectBinding | null;
}): Promise<MacDesktopCloseAnswer> {
  const { laneId } = args;
  if (!laneId) return "stop";
  const api = window.ade?.macDesktop;
  if (!api?.getStatus) return "stop";
  const pin = args.runtimePin ?? null;
  const status = await withMacDesktopTimeout(
    api.getStatus({ laneId, chatSessionId: args.chatSessionId ?? null }, pin ?? undefined),
  ).catch(() => null);
  if (!status) return "stop";
  publishMacDesktopStatus(macDesktopStatusKey(laneId, pin), { status, confirmed: true });
  if (!status.display) return "stop";
  return askMacDesktopStopConfirm();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: an unanswered question from one test must not reach the next. */
export function resetMacDesktopStopConfirmForTests(): void {
  pending = null;
  listeners = new Set();
}

/** Mounts the question. One per Work page, beside the Apple one. */
export function MacDesktopStopConfirmHost() {
  const request = useSyncExternalStore(subscribe, getMacDesktopStopConfirmRequest, getMacDesktopStopConfirmRequest);
  if (!request) return null;
  return <MacDesktopStopConfirmDialog />;
}

function MacDesktopStopConfirmDialog() {
  return (
    <Dialog
      open
      role="alertdialog"
      tone="error"
      width={420}
      title="Stop Mac Desktop?"
      description="Apps this lane opened quit, even with unsaved work. Windows you moved here go back to your main screen. Keep it running if the agent still needs it."
      hideClose
      testId="mac-desktop-close-confirm"
      onOpenChange={(open) => { if (!open) settle("cancel"); }}
      actions={[
        {
          label: "Keep running",
          variant: "secondary",
          onClick: () => settle("keep"),
        },
        {
          label: "Stop",
          autoFocus: true,
          onClick: () => settle("stop"),
        },
      ]}
    />
  );
}

