import { useState, useSyncExternalStore } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChatCircleText, Copy, ListBullets, Warning, X } from "@phosphor-icons/react";
import type { AndroidAppCrash } from "../../../shared/types/androidEmulator";
import { usePortalContainer } from "../ui/portalContainer";
import { Z_LAYERS } from "../ui/zLayers";
import { noticeTone } from "../ui/notice/noticeTones";
import { DRAWER_BUTTON, DRAWER_PRIMARY_BUTTON } from "../ui/drawerPrimitives";

/**
 * The crash pin (plan §5, P2): a red pin on the device when the lane's app
 * crashes, with the stack, "Send to chat", Copy and the Logs group.
 *
 * The crash comes from the lane status (`appCrash`, the brain's crash-buffer
 * watch), so every viewer of the lane sees it, on any machine. × hides that
 * crash in this window until the next one; it is the app's failure, not
 * ADE's, so nothing is reported.
 */

const dismissed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function dismissCrash(id: string): void {
  dismissed.add(id);
  version += 1;
  for (const listener of listeners) listener();
}

function useDismissedVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/** The chat draft "Send to chat" writes: what crashed, then the crash lines. */
export function androidCrashDraft(crash: AndroidAppCrash): string {
  const app = crash.packageName ?? "The app";
  return `${app} crashed on the lane's Android emulator:\n\n\`\`\`text\n${crash.stack}\n\`\`\`\n`;
}

export function AndroidCrashPin({
  crash,
  onSendToChat,
  onOpenLogs,
}: {
  crash: AndroidAppCrash | null;
  /** Absent where there is no chat to write into. */
  onSendToChat?: ((text: string) => void) | undefined;
  onOpenLogs: () => void;
}) {
  useDismissedVersion();
  const [open, setOpen] = useState(false);
  const portalContainer = usePortalContainer();
  if (!crash || dismissed.has(crash.id)) return null;
  const tone = noticeTone("error");
  const app = crash.packageName ?? "The app";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-android-crash-pin={crash.id}
          className="pointer-events-auto inline-flex h-6 max-w-[260px] items-center gap-1 rounded-full border px-2 font-sans text-[11px] font-medium shadow-sm backdrop-blur-sm transition-colors"
          style={{ color: tone.text, background: tone.soft, borderColor: tone.edge }}
          title="Show the crash"
        >
          <Warning size={12} weight="fill" className="shrink-0" />
          <span className="truncate">{app} crashed</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="outline-none"
          style={{ zIndex: Z_LAYERS.popover }}
        >
          <div
            data-android-crash-card=""
            className="flex w-[380px] max-w-[calc(100vw-24px)] flex-col gap-2 rounded-xl border border-fg/[0.08] bg-(color:--work-popover-bg) p-3 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-md"
          >
            <div className="flex items-start gap-1.5">
              <Warning size={13} weight="fill" className="mt-[2px] shrink-0" style={{ color: tone.color }} />
              <div className="min-w-0 flex-1">
                <p className="m-0 break-words text-[12px] font-semibold leading-snug text-fg">{app} crashed</p>
                <p className="m-0 break-words font-mono text-[11px] leading-snug text-fg/75">{crash.summary}</p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-fg/60 hover:bg-fg/[0.06] hover:text-fg"
                aria-label="Dismiss this crash"
                title="Dismiss this crash"
                onClick={() => {
                  setOpen(false);
                  dismissCrash(crash.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
            <pre className="m-0 max-h-56 overflow-auto whitespace-pre rounded-md bg-fg/[0.04] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-fg/75 select-text">
              {crash.stack}
            </pre>
            <div className="flex flex-wrap items-center gap-1.5">
              {onSendToChat ? (
                <button
                  type="button"
                  className={DRAWER_PRIMARY_BUTTON}
                  onClick={() => {
                    onSendToChat(androidCrashDraft(crash));
                    setOpen(false);
                  }}
                >
                  <ChatCircleText size={13} />
                  Send to chat
                </button>
              ) : null}
              <button
                type="button"
                className={DRAWER_BUTTON}
                onClick={() => { void window.ade?.app?.writeClipboardText?.(crash.stack); }}
              >
                <Copy size={13} />
                Copy
              </button>
              <button
                type="button"
                className={DRAWER_BUTTON}
                onClick={() => {
                  setOpen(false);
                  onOpenLogs();
                }}
              >
                <ListBullets size={13} />
                Open Logs
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
