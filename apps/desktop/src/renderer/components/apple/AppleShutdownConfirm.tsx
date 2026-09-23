import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { OpenProjectBinding } from "../../../shared/types";
import { getFocusableElements } from "../ui/dialogFocus";

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
  if (!lane) return true;
  const booted = listed?.installed.find((entry) => entry.udid === lane.udid)?.state === "Booted";
  if (!booted) return true;
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
  const panelRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancel = useCallback(() => settle(false), []);
  const confirm = useCallback(() => settle(true), []);

  // Escape cancels, Enter confirms — bound at the window, because clicking the
  // dialog's own sentence leaves focus on <body> and a panel handler would then
  // never see the key.
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

  // The destructive verb takes focus, because it is the answer the user came
  // here to give: they clicked the tab's ×.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => confirmRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const body = (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}
    >
      <section
        ref={(node) => { panelRef.current = node; }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="apple-shutdown-confirm-title"
        aria-describedby="apple-shutdown-confirm-body"
        data-testid="apple-shutdown-confirm"
        className="w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border/70 bg-surface-overlay text-fg shadow-float"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = getFocusableElements(event.currentTarget);
          if (nodes.length === 0) return;
          const first = nodes[0]!;
          const last = nodes[nodes.length - 1]!;
          const active = document.activeElement as HTMLElement | null;
          if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id="apple-shutdown-confirm-title" className="font-sans text-[14px] font-semibold text-fg/92">
            Shut down {request.deviceName}?
          </h2>
          <p id="apple-shutdown-confirm-body" className="mt-2 text-[12px] leading-5 text-muted-fg">
            Closing this tab powers off the simulator.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3.5">
          <button
            type="button"
            onClick={cancel}
            className="inline-flex h-8 items-center rounded-md border border-border/60 px-3 text-[11px] font-semibold text-muted-fg transition-colors hover:text-fg/85"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={confirm}
            className="inline-flex h-8 items-center rounded-md border border-[color:color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-error)_18%,transparent)] px-3 text-[11px] font-semibold text-fg transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-error)_26%,transparent)]"
          >
            Close and shut down
          </button>
        </footer>
      </section>
    </div>
  );

  return typeof document === "undefined" ? body : createPortal(body, document.body);
}
