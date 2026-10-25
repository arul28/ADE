/**
 * Find bars.
 *
 * `FindField` is the one field every find bar draws: the input, "3 of 17",
 * previous, next, close, with the keys every find bar has (Enter / Shift-Enter
 * step, Escape closes the bar and nothing else). The browser pane wraps it in
 * its toolbar row (BrowserFindBar); `FindBar` floats it over a chat transcript
 * or a diff.
 */
import type { MutableRefObject } from "react";
import { CaretDown, CaretUp, MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { isImeComposing } from "../../lib/imeComposition";

type FindFieldProps = {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  /** Step to the next (1) or previous (-1) match. */
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** "3 of 17", "No results", "Searching…", or an error. */
  status: string;
  statusTone?: "count" | "warning";
  /** Steps are possible (there is at least one match, or more may come). */
  canStep: boolean;
  placeholder: string;
  /** Classes for the field and each icon button, so a host can match its own chrome. */
  inputClassName?: string;
  buttonClassName: string;
};

export function FindField({
  inputRef,
  query,
  onQueryChange,
  onStep,
  onClose,
  status,
  statusTone = "count",
  canStep,
  placeholder,
  inputClassName,
  buttonClassName,
}: FindFieldProps) {
  return (
    <>
      <MagnifyingGlass size={13} className="shrink-0 text-muted-fg/55" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          // Escape closes the bar and nothing else: not the pane, tool or
          // dialog around it.
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || isImeComposing(event)) return;
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          // No focus halo: the bar around the field is the focus affordance.
          "h-full min-w-0 flex-1 bg-transparent text-[12px] text-fg/85 outline-none placeholder:text-muted-fg/45 focus:shadow-none! focus-visible:shadow-none!",
          inputClassName,
        )}
      />
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "min-w-0 shrink-0 truncate text-[10.5px]",
          statusTone === "warning" ? "font-sans text-amber-200/85" : "font-mono text-muted-fg/70",
        )}
      >
        {status}
      </span>
      <button type="button" onClick={() => onStep(-1)} disabled={!canStep} title="Previous match (⇧↵)" aria-label="Previous match" className={buttonClassName}>
        <CaretUp size={12} />
      </button>
      <button type="button" onClick={() => onStep(1)} disabled={!canStep} title="Next match (↵)" aria-label="Next match" className={buttonClassName}>
        <CaretDown size={12} />
      </button>
      <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close find bar" className={buttonClassName}>
        <X size={12} />
      </button>
    </>
  );
}

type FindBarProps = Omit<FindFieldProps, "buttonClassName" | "inputClassName"> & {
  className?: string;
};

/**
 * `.kit-find-bar` height (36) plus the bar's top offset (6). A diff reserves
 * this much room above its first line while the bar is open; the chat
 * transcript does not (the bar floats over its top-right, which a reader
 * scrolls past).
 */
export const FLOATING_FIND_BAR_RESERVE_PX = 42;

/**
 * The floating ⌘F bar for a chat transcript or a diff: a `kit-card` pinned to
 * the top-right of the surface's positioned box. Its `z-20` orders it above
 * that surface's content; it creates no stacking context of its own, so an
 * in-pane pill with a higher small step (`z-30`, `z-40`) can draw over it, and
 * every app layer (`Z_LAYERS`) does.
 */
export function FindBar({ className, ...field }: FindBarProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1.5 z-20 flex justify-end px-2">
      <form
        role="search"
        aria-label={field.placeholder}
        // Escape belongs to the bar: surfaces that close on Escape skip anything
        // inside a declared scope.
        data-ade-escape-scope="find"
        data-ade-find-skip=""
        onSubmit={(event) => {
          event.preventDefault();
          field.onStep(1);
        }}
        onMouseDown={(event) => {
          // Clicking the bar's own chrome keeps the caret in the field.
          if (event.target !== field.inputRef.current) event.preventDefault();
        }}
        className={cn("kit-card kit-find-bar pointer-events-auto w-[min(360px,100%)]", className)}
      >
        <FindField {...field} buttonClassName="kit-icon-btn" />
      </form>
    </div>
  );
}
