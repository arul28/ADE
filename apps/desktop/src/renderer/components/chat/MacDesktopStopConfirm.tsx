import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { OpenProjectBinding } from "../../../shared/types";
import { getFocusableElements } from "../ui/dialogFocus";
import { macDesktopStatusKey, publishMacDesktopStatus, withMacDesktopTimeout } from "./macDesktopStatusStore";

/**
 * "Stop Mac Desktop?", the question closing the Mac Desktop TAB asks.
 *
 * Closing the tab stops the lane's display and sends its windows back to the
 * main screen. The Apple tab asks before it powers a simulator off; this tab
 * did not ask at all, so a stray click on × ended the display with no warning.
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
  const panelRef = useRef<HTMLElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const cancel = useCallback(() => settle("cancel"), []);

  // Escape cancels, bound at the window so it works wherever focus is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  // Stop takes focus: it is what the × asked for.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => stopRef.current?.focus());
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
        aria-labelledby="mac-desktop-stop-confirm-title"
        aria-describedby="mac-desktop-stop-confirm-body"
        data-testid="mac-desktop-close-confirm"
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
          <h2 id="mac-desktop-stop-confirm-title" className="font-sans text-[14px] font-semibold text-fg/92">
            Stop Mac Desktop?
          </h2>
          <p id="mac-desktop-stop-confirm-body" className="mt-2 text-[12px] leading-5 text-muted-fg">
            This lane's windows go back to your main screen. Keep it running if the agent still needs it.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3.5">
          <button
            type="button"
            data-testid="mac-desktop-close-keep"
            onClick={() => settle("keep")}
            className="inline-flex h-8 items-center rounded-md border border-border/60 px-3 text-[11px] font-semibold text-muted-fg transition-colors hover:text-fg/85"
          >
            Keep running
          </button>
          <button
            ref={stopRef}
            type="button"
            data-testid="mac-desktop-close-stop"
            onClick={() => settle("stop")}
            className="inline-flex h-8 items-center rounded-md border border-[color:color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-error)_18%,transparent)] px-3 text-[11px] font-semibold text-fg transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-error)_26%,transparent)]"
          >
            Stop
          </button>
        </footer>
      </section>
    </div>
  );

  return typeof document === "undefined" ? body : createPortal(body, document.body);
}
