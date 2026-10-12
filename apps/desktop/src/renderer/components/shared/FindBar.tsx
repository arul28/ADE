/**
 * The ⌘F bar for a chat transcript or a diff: a field, "3 of 17", previous,
 * next, close. Same keys as every find bar: Enter / Shift-Enter step, Escape
 * closes the bar and nothing else.
 *
 * The browser pane keeps its own bar (BrowserFindBar): it sits in that pane's
 * chrome row and drives the page's native find.
 */
import type { MutableRefObject } from "react";
import { CaretDown, CaretUp, MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { FIND_SKIP_ATTRIBUTE } from "../../lib/findText";

/**
 * Put the caret in a find bar that is opening. The bar may mount while its
 * surface is still settling (a chat that a palette result is switching to is
 * parked until the switch lands), so keep trying for a moment — unless the
 * user has focused something else meanwhile.
 */
export function focusFindInput(inputRef: MutableRefObject<HTMLInputElement | null>, untilMs = performance.now() + 1_500): void {
  const first = untilMs - performance.now() > 1_400;
  requestAnimationFrame(() => {
    const input = inputRef.current;
    const active = document.activeElement;
    if (input && active === input) return;
    const free = !active || active === document.body || active === document.documentElement;
    if (input?.isConnected && (free || first) && !input.closest("[inert]")) {
      input.focus();
      input.select();
    }
    if (performance.now() < untilMs) focusFindInput(inputRef, untilMs);
  });
}

export type FindBarProps = {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  /** Step to the next (1) or previous (-1) match. */
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** "3 of 17", "No results", "Searching…" */
  status: string;
  /** Steps are possible (there is at least one match, or more may come). */
  canStep: boolean;
  placeholder: string;
  className?: string;
};

const BUTTON_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/75 transition-colors hover:bg-fg/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-35";

export function FindBar({
  inputRef,
  query,
  onQueryChange,
  onStep,
  onClose,
  status,
  canStep,
  placeholder,
  className,
}: FindBarProps) {
  return (
    <form
      role="search"
      aria-label={placeholder}
      // Escape belongs to the bar: surfaces that close on Escape skip anything
      // inside a declared scope.
      data-ade-escape-scope="find"
      {...{ [FIND_SKIP_ATTRIBUTE]: "" }}
      onSubmit={(event) => {
        event.preventDefault();
        onStep(1);
      }}
      onMouseDown={(event) => {
        // Clicking the bar's own chrome keeps the caret in the field.
        if (event.target !== inputRef.current) event.preventDefault();
      }}
      className={cn(
        "flex h-9 min-w-0 select-none items-center gap-1.5 rounded-lg border border-fg/[0.10] bg-(color:--color-surface-recessed) pl-2.5 pr-1 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)]",
        className,
      )}
    >
      <MagnifyingGlass size={13} className="shrink-0 text-muted-fg/55" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-fg/85 outline-none placeholder:text-muted-fg/45 focus:shadow-none! focus-visible:shadow-none!"
      />
      <span role="status" aria-live="polite" className="min-w-0 shrink-0 truncate font-mono text-[10.5px] text-muted-fg/70">
        {status}
      </span>
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={!canStep}
        title="Previous match (⇧↵)"
        aria-label="Previous match"
        className={BUTTON_CLASS}
      >
        <CaretUp size={12} />
      </button>
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={!canStep}
        title="Next match (↵)"
        aria-label="Next match"
        className={BUTTON_CLASS}
      >
        <CaretDown size={12} />
      </button>
      <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close find" className={BUTTON_CLASS}>
        <X size={12} />
      </button>
    </form>
  );
}
