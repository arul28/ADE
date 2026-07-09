import { useRef, useState } from "react";
import { CaretDown, Code } from "@phosphor-icons/react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { cn } from "../../ui/cn";
import { inputCls, textareaCls } from "../designTokens";
import { variablesForTrigger } from "../variableCatalog";

/**
 * A `{}` inserter button that lists the `{{trigger.*}}` variables available for
 * the current trigger and inserts the chosen token at the input's cursor. Text
 * is stored raw — no rich pill rendering, just insert-at-cursor with a hint.
 */
function VariableButton({
  triggerType,
  onInsert,
  className,
}: {
  triggerType: string;
  onInsert: (token: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), open);
  const groups = variablesForTrigger(triggerType);

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Insert variable"
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium transition-colors",
          open
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-white/[0.08] bg-white/[0.03] text-muted-fg/70 hover:border-accent/30 hover:text-fg",
        )}
      >
        <Code size={11} weight="bold" />
        Insert variable
        <CaretDown size={9} weight="bold" className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1 max-h-[280px] w-[220px] overflow-y-auto rounded-lg border border-white/[0.08] bg-surface-overlay p-1 shadow-float">
          {groups.map((group) => (
            <div key={group.title} className="mb-1 last:mb-0">
              <div className="px-2 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg/50">
                {group.title}
              </div>
              {group.variables.map((variable) => (
                <button
                  key={variable.token}
                  type="button"
                  onClick={() => {
                    onInsert(variable.token);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-white/[0.05]"
                >
                  <span className="text-[11px] text-fg">{variable.label}</span>
                  <span className="truncate font-mono text-[9.5px] text-muted-fg/50">{variable.token}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function insertAtCursor(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  current: string,
  token: string,
): { next: string; caret: number } {
  if (!el) return { next: current + token, caret: current.length + token.length };
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + token + current.slice(end);
  return { next, caret: start + token.length };
}

export function VariableInput({
  value,
  onChange,
  triggerType,
  placeholder,
  className,
  showVariables = true,
}: {
  value: string;
  onChange: (next: string) => void;
  triggerType: string;
  placeholder?: string;
  className?: string;
  showVariables?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <div className="relative">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputCls, showVariables && "pr-[132px]", className)}
      />
      {showVariables ? (
        <VariableButton
          triggerType={triggerType}
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
          onInsert={(token) => {
            const { next, caret } = insertAtCursor(ref.current, value, token);
            onChange(next);
            requestAnimationFrame(() => {
              const el = ref.current;
              if (el) {
                el.focus();
                el.setSelectionRange(caret, caret);
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}

export function VariableTextarea({
  value,
  onChange,
  triggerType,
  placeholder,
  className,
  rows,
}: {
  value: string;
  onChange: (next: string) => void;
  triggerType: string;
  placeholder?: string;
  className?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.03] transition-colors focus-within:border-accent/45 focus-within:ring-1 focus-within:ring-accent/20">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck
        autoCorrect="on"
        autoCapitalize="sentences"
        className={cn(
          "w-full resize-y bg-transparent px-2.5 pt-2 text-xs leading-relaxed text-fg outline-none placeholder:text-muted-fg/55",
          className,
        )}
      />
      <div className="flex items-center justify-end border-t border-white/[0.05] px-1.5 py-1">
        <VariableButton
          triggerType={triggerType}
          onInsert={(token) => {
            const { next, caret } = insertAtCursor(ref.current, value, token);
            onChange(next);
            requestAnimationFrame(() => {
              const el = ref.current;
              if (el) {
                el.focus();
                el.setSelectionRange(caret, caret);
              }
            });
          }}
        />
      </div>
    </div>
  );
}

// textareaCls re-exported for callers that want the plain (non-variable) look.
export { textareaCls };
