import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { Dialog } from "../ui/dialog";
import { laneDeviceBooted } from "./appleDeviceState";

/**
 * "Shut down {device}?" — the one question closing the Apple Development TAB
 * has to ask (round 4 §B3).
 *
 * Closing the tab powers the simulator off. That is the right rule (a tool you
 * closed should not keep burning a device), but it is also destructive and
 * invisible: the pane is gone before the shutdown lands, so a mis-click costs a
 * booted device, its app state and its stream with no way back but a 30-second
 * boot. So: confirm first, and ONLY when the device is actually booted —
 * closing the tab on a device that is already off asks nothing.
 *
 * Deliberately ADE's own dialog, never `window.confirm` and never a macOS
 * sheet. The native ones are modal to the whole WINDOW (they freeze every other
 * lane's chat and every stream in the app while they are up), they cannot be
 * driven by a test, and they wear the OS's chrome in the middle of a product
 * that has its own.
 *
 * An imperative promise rather than a component the tab strip renders, because
 * the caller is `closeTool` — a callback inside a store-writing hook, with no
 * JSX of its own and no place to hang a `<Dialog open>` from. The host below is
 * mounted once per Work page beside the floating player.
 */

export type AppleShutdownConfirmRequest = {
  deviceName: string;
  resolve: (confirmed: boolean) => void;
};

let pending: AppleShutdownConfirmRequest | null = null;
let listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function settle(confirmed: boolean): void {
  const request = pending;
  pending = null;
  emit();
  request?.resolve(confirmed);
}

/** The question on screen right now, if any. */
export function getAppleShutdownConfirmRequest(): AppleShutdownConfirmRequest | null {
  return pending;
}

/**
 * Ask, and resolve with the answer.
 *
 * A second ask while one is on screen resolves FALSE rather than replacing the
 * first: two dialogs cannot both be answered, and the safe reading of "I could
 * not ask you" is "do not power the device off".
 */
export function askAppleShutdownConfirm(deviceName: string): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { deviceName, resolve };
    emit();
  });
}

/**
 * Whether the Apple tool's tab may close, asking first when a device is up.
 *
 * Resolves true — with no dialog at all — when there is no lane, no device, no
 * simulator API, or the lane's device is not booted. Those are the cases where
 * closing the tab costs nothing, and a confirmation for a free action is the
 * fastest way to teach someone to dismiss confirmations.
 *
 * A `deviceList` that fails resolves TRUE: a close that cannot be checked must
 * still close, or an unreachable runtime would pin a tab open forever.
 */
export async function confirmAppleToolClose(args: {
  laneId: string | null;
  runtimePin?: OpenProjectBinding | null;
}): Promise<boolean> {
  const { laneId } = args;
  if (!laneId) return true;
  const api = window.ade?.iosSimulator;
  if (!api?.deviceList) return true;
  const listed = await api
    .deviceList({ laneId, installed: true }, args.runtimePin ?? undefined)
    .catch(() => null);
  const lane = listed?.lane ?? null;
  if (!lane || !laneDeviceBooted(listed)) return true;
  return askAppleShutdownConfirm(lane.name);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: an unanswered question from one test must not reach the next. */
export function resetAppleShutdownConfirmForTests(): void {
  pending = null;
  listeners = new Set();
}

/**
 * Mounts the question. One per Work page, beside the floating player.
 *
 * Renders nothing at all until something asks, so the cost of having it mounted
 * is one store subscription.
 */
export function AppleShutdownConfirmHost() {
  const request = useSyncExternalStore(subscribe, getAppleShutdownConfirmRequest, getAppleShutdownConfirmRequest);
  if (!request) return null;
  return <AppleShutdownConfirmDialog request={request} />;
}

function AppleShutdownConfirmDialog({ request }: { request: AppleShutdownConfirmRequest }) {
  const cancel = useCallback(() => settle(false), []);
  const confirm = useCallback(() => settle(true), []);

  // Escape cancels, Enter confirms — bound at the window, because clicking the
  // dialog's own sentence leaves focus off the buttons and a panel handler
  // would then never see the key. Capture + stopPropagation so the Work page's
  // own Escape handlers never see the key that answered this question.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      // A focused button answers Enter itself; this is for the rest of the box.
      if ((event.target as HTMLElement | null)?.tagName?.toLowerCase() === "button") return;
      event.preventDefault();
      confirm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, confirm]);

  // The destructive verb takes focus (`autoFocus`), because it is the answer
  // the user came here to give: they clicked the tab's ×. The nested layer
  // keeps the question above any other dialog that happens to be open.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      role="alertdialog"
      layer="nestedDialog"
      testId="apple-shutdown-confirm"
      title={`Shut down ${request.deviceName}?`}
      description="Closing this tab powers off the simulator."
      tone="error"
      hideClose
      width={420}
      actions={[
        { label: "Cancel", onClick: cancel, variant: "secondary" },
        { label: "Close and shut down", onClick: confirm, variant: "solid", autoFocus: true },
      ]}
    />
  );
}
