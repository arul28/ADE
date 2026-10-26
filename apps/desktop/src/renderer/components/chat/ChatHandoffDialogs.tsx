import { memo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { PortalContainerContext } from "../ui/portalContainer";

// Top-anchored so switching Fork/Brief (different heights) does not move the header.
const OVERLAY_CLASS = "fixed inset-0 z-[80] flex items-start justify-center bg-black/55 p-6 pt-[14vh]";
const PANEL_CLASS = "rounded-xl border border-fg/[0.08] bg-[var(--color-bg)] shadow-2xl outline-none";
const CLOSE_BUTTON_CLASS = "rounded-md border border-fg/[0.08] px-3 py-1.5 font-sans text-[11px] text-fg/70";

/**
 * One handoff dialog shell. Radix gives Escape, outside-press dismiss, and focus
 * handling. The overlay holds the content so the panel stays centered. Popovers
 * inside (the lane picker) portal into the content, where they stay clickable.
 */
function HandoffDialog({
  open,
  onClose,
  title,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  className: string;
  children: ReactNode;
}) {
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS}>
          <Dialog.Content
            ref={setContentEl}
            aria-describedby={undefined}
            className={`${PANEL_CLASS} ${className}`}
            // Radix sees Escape first. While a lane list is open in the dialog,
            // Escape must close only the list, which the combobox does itself.
            onEscapeKeyDown={(event) => {
              if (contentEl?.querySelector(".ade-lane-popover, [data-permission-mode-picker-dropdown]")) event.preventDefault();
            }}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <PortalContainerContext.Provider value={contentEl}>{children}</PortalContainerContext.Provider>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The two handoff dialogs the chat pane owns: the local handoff form, and the
 * notice for a chat that runs on another machine. The cross-machine form itself
 * is `CrossMachineHandoffModal`.
 *
 * Memoized: the pane re-renders on every streamed event, and a closed dialog
 * must not re-render with it. The pane passes `localContent` only while the
 * local form is open, and a stable `onCloseLocal`, so props hold still.
 */
export const ChatHandoffDialogs = memo(function ChatHandoffDialogs({
  localOpen,
  localContent,
  onCloseLocal,
}: {
  localOpen: boolean;
  /** The local handoff form, or null when this chat cannot hand off. */
  localContent: ReactNode | null;
  onCloseLocal: () => void;
}) {
  return (
    <>
      <HandoffDialog
        open={localOpen}
        onClose={onCloseLocal}
        title="Local handoff"
        className="flex max-h-[min(720px,82vh)] w-[min(580px,94vw)] flex-col overflow-hidden"
      >
        {localContent ?? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <p className="font-sans text-[13px] text-fg/50">Handoff is not available for this chat.</p>
            <button type="button" className={CLOSE_BUTTON_CLASS} onClick={onCloseLocal}>
              Close
            </button>
          </div>
        )}
      </HandoffDialog>
    </>
  );
});
