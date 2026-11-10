import type { ReactNode } from "react";
import { cn } from "../ui/cn";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";
import { MacDesktopStatusStrip, type MacDesktopStripMessage } from "./MacDesktopStatusStrip";

/**
 * A small card centred on the picture. Only its own box takes the pointer:
 * the rest of the screen stays the surface's, so a takeover is not blocked.
 */
export function MacDesktopPictureCard({
  testId,
  title,
  line,
  children,
}: {
  testId: string;
  title: string;
  line: string;
  children?: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[12] flex items-center justify-center p-3">
      <div
        role="status"
        data-testid={testId}
        className="pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 rounded-[12px] border border-border/70 bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-4 py-3 text-center font-sans shadow-float"
      >
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="text-[12px] leading-5 text-muted-fg">{line}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * A live Linux screen with nothing open is one flat colour, which reads as
 * dead: this card says so and opens the app picker. The pane decides when it
 * shows (see `MacDesktopPaneView`).
 */
export function MacDesktopEmptyScreenHint({ onAddApp }: { onAddApp: () => void }) {
  return (
    <MacDesktopPictureCard testId="mac-desktop-empty-screen" title="Nothing is open yet" line="Open an app, or ask the agent to.">
      <button type="button" className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-7")} onClick={onAddApp}>
        Add app
      </button>
    </MacDesktopPictureCard>
  );
}

/**
 * The way out, on the picture, for the whole takeover.
 *
 * During a takeover ⌘Q is held back and clicks move focus onto the lane's
 * screen, so Escape is the exit. The hint sits on the picture, where the
 * person is looking, and a narrow pane does not clip it. Click-through
 * except the button, so it never steals a click from the lane.
 *
 * A refused input only exists while this view drives (the controller clears
 * it when control ends), so it is drawn with the hint: over the top of the
 * picture, where it moves nothing. Only the banner takes the pointer.
 */
export function MacDesktopTakeoverHint({
  suffix,
  inputError,
  onDismissInputError,
  onReturnControl,
}: {
  /** "" in the pane, "-fs" in full screen: keeps the test ids apart. */
  suffix: "" | "-fs";
  inputError: string | null;
  onDismissInputError: () => void;
  onReturnControl: () => void;
}) {
  const inputNotice: MacDesktopStripMessage | null = inputError
    ? {
      key: `input:${inputError}`,
      tone: "error",
      sentence: inputError,
      onDismiss: onDismissInputError,
      testId: "mac-desktop-input-error",
    }
    : null;
  return (
    <>
      {inputNotice ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[13]">
          <div className="pointer-events-auto">
            <MacDesktopStatusStrip message={inputNotice} suffix={suffix} />
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[13] flex justify-center px-3">
        <div
          role="status"
          data-testid={`mac-desktop-takeover-banner${suffix}`}
          className="flex items-center gap-2 rounded-full border border-amber-300/30 bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-3 py-1 font-sans text-[12px] text-fg shadow-float"
        >
          <span>
            You're driving this screen. Press <kbd className="font-medium text-amber-200">Esc</kbd> to give it back.
          </span>
          <button
            type="button"
            className="pointer-events-auto text-amber-200 underline underline-offset-2"
            onClick={onReturnControl}
          >
            Return to agent
          </button>
        </div>
      </div>
    </>
  );
}
