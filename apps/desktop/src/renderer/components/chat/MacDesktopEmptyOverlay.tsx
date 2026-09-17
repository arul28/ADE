import { useCallback, useState } from "react";
import { ArrowSquareIn, CircleNotch, Plus, X } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";

/**
 * The card on an empty lane screen.
 *
 * It sits ON the live picture rather than under it, because the picture is the
 * point: the desktop stays visible behind a small centered card that names the
 * two ways to put something on it. The version this replaces was a footer line
 * with a copy-me CLI command in it, under the video, where an empty screen read
 * as a broken one.
 *
 * Dismissible, and gone by itself the moment a window parks — the panel simply
 * stops rendering it once `parked` is non-empty.
 */
export function MacDesktopEmptyOverlay({
  onClaim,
  onOpenApp,
  onDismiss,
  busy,
}: {
  onClaim: () => void;
  /** Runs `open` with whatever the user typed. Rejects surface as the error line. */
  onOpenApp: (target: string) => Promise<void>;
  onDismiss: () => void;
  busy: boolean;
}) {
  const [openInput, setOpenInput] = useState(false);
  const [target, setTarget] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const value = target.trim();
    if (!value || opening) return;
    setOpening(true);
    setError(null);
    try {
      await onOpenApp(value);
      setTarget("");
      setOpenInput(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpening(false);
    }
  }, [onOpenApp, opening, target]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4"
      data-testid="mac-desktop-empty-overlay"
    >
      <div
        className={cn(
          "pointer-events-auto relative w-[min(340px,100%)] rounded-[14px] px-4 pb-4 pt-3.5 text-center",
          "border border-border/70 bg-[color-mix(in_srgb,var(--color-surface-overlay)_92%,transparent)]",
          "shadow-float backdrop-blur-md",
        )}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="mac-desktop-empty-dismiss"
          className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-[6px] text-muted-fg transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg"
        >
          <X size={12} />
        </button>

        <p className="font-sans text-[13.5px] font-medium text-fg/90">Nothing on this screen yet</p>
        <p className="mt-1 text-[11.5px] leading-[1.45] text-muted-fg">
          Move a window you already have open onto this lane's screen, or launch an app straight onto it.
        </p>

        {openInput ? (
          <form
            className="mt-3 flex items-center gap-1.5"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}
          >
            <input
              autoFocus
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="App name, e.g. Safari"
              aria-label="App to open on this lane's screen"
              data-testid="mac-desktop-open-app-input"
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-border/70 bg-black/20 px-2 text-[12px] text-fg outline-none placeholder:text-muted-fg/70 focus:border-accent/70"
              onKeyDown={(event) => {
                // Escape closes the input, not the panel's full screen.
                if (event.key === "Escape") { event.stopPropagation(); setOpenInput(false); }
              }}
            />
            <button
              type="submit"
              disabled={!target.trim() || opening}
              data-testid="mac-desktop-open-app-submit"
              className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-8")}
            >
              {opening ? <CircleNotch size={13} className="animate-spin" /> : <Plus size={13} />}
              Open
            </button>
          </form>
        ) : (
          <div className="mt-3 flex items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={onClaim}
              disabled={busy}
              data-testid="mac-desktop-empty-claim"
              className={cn(WORK_TOOL_PRIMARY_BUTTON, "h-8")}
            >
              <ArrowSquareIn size={13} />
              Claim a window
            </button>
            <button
              type="button"
              onClick={() => setOpenInput(true)}
              data-testid="mac-desktop-empty-open-app"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border/70 px-3 text-[12px] font-medium text-fg/80 transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg"
            >
              <Plus size={13} />
              Open an app
            </button>
          </div>
        )}

        {error ? (
          <p className="mt-2 text-[11px] text-amber-300" data-testid="mac-desktop-open-app-error">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
