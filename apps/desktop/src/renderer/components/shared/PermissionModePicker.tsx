import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretDown,
  Check,
  Desktop,
  GearSix,
  Lightning,
  PencilSimple,
  RocketLaunch,
  ShieldCheck,
  ShieldWarning,
  Strategy,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/**
 * The permission-mode pill from the chat composer, lifted into `shared/` so the
 * cross-machine handoff modal can render the exact same control.
 *
 * It used to live inside `AgentChatComposer.tsx` as a private component, which
 * is why the handoff modal shipped with a model picker and nothing else — there
 * was no permission control it could reach without duplicating one. Anything
 * that lets a user choose how a chat starts should render this, not a lookalike.
 */

const PERMISSION_MODE_MENU_WIDTH = 240;

/**
 * Shared trigger chrome for permission pills. Previously hand-copied into both
 * `AgentChatComposer` and `SessionLaunchModelControls`; every surface that shows
 * a permission pill reads it from here so they stay one control visually.
 */
export const PERMISSION_TRIGGER_CLASS = cn(
  "ade-chat-composer-permission-trigger",
  "inline-flex h-6 min-w-0 shrink-0 items-center justify-start gap-1 rounded-md border px-1.5",
  // The fallback in the calc() matters. `--chat-font-size` is only defined on a
  // chat appearance root, so on the launch and handoff surfaces the bare token
  // computes as invalid and the pill silently inherits the ambient size. With
  // 14px as the fallback the expression is always valid: chat-scaled inside a
  // chat, and the original fixed 10.5px everywhere else.
  "font-sans text-[length:calc(var(--chat-font-size,14px)*9/14)] leading-none transition-colors duration-150",
  "border-white/[0.06] bg-white/[0.03] text-fg/80",
  "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
);

export type PermissionModeTone = "green" | "amber" | "blue" | "purple" | "red" | "slate";
export type PermissionModeIconKind = "manual" | "auto" | "edit" | "plan" | "full" | "config" | "agent" | "agi";

export type PermissionModePickerOption<Value extends string = string> = {
  value: Value;
  label: string;
  triggerLabel?: string;
  detail: string;
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
};

const PERMISSION_MODE_TONE_STYLES: Record<
  PermissionModeTone,
  {
    dot: string;
    trigger: string;
    iconSurface: string;
    rowActive: string;
    rowHover: string;
  }
> = {
  green: {
    dot: "bg-emerald-400",
    trigger: "border-emerald-400/24 bg-emerald-500/[0.08] text-emerald-100",
    iconSurface: "border-emerald-300/20 bg-emerald-500/[0.12] text-emerald-200",
    rowActive: "bg-emerald-500/[0.12] text-emerald-50",
    rowHover: "hover:bg-emerald-500/[0.08] hover:text-emerald-50",
  },
  amber: {
    dot: "bg-amber-400",
    trigger: "border-amber-300/22 bg-amber-500/[0.08] text-amber-100",
    iconSurface: "border-amber-300/20 bg-amber-500/[0.12] text-amber-200",
    rowActive: "bg-amber-500/[0.12] text-amber-50",
    rowHover: "hover:bg-amber-500/[0.08] hover:text-amber-50",
  },
  blue: {
    dot: "bg-sky-400",
    trigger: "border-sky-300/22 bg-sky-500/[0.08] text-sky-100",
    iconSurface: "border-sky-300/20 bg-sky-500/[0.12] text-sky-200",
    rowActive: "bg-sky-500/[0.12] text-sky-50",
    rowHover: "hover:bg-sky-500/[0.08] hover:text-sky-50",
  },
  purple: {
    dot: "bg-violet-400",
    trigger: "border-violet-300/24 bg-violet-500/[0.09] text-violet-100",
    iconSurface: "border-violet-300/20 bg-violet-500/[0.14] text-violet-200",
    rowActive: "bg-violet-500/[0.14] text-violet-50",
    rowHover: "hover:bg-violet-500/[0.08] hover:text-violet-50",
  },
  red: {
    dot: "bg-red-400",
    trigger: "border-red-300/24 bg-red-500/[0.09] text-red-100",
    iconSurface: "border-red-300/20 bg-red-500/[0.14] text-red-200",
    rowActive: "bg-red-500/[0.14] text-red-50",
    rowHover: "hover:bg-red-500/[0.08] hover:text-red-50",
  },
  slate: {
    dot: "bg-slate-300",
    trigger: "border-white/[0.08] bg-white/[0.045] text-fg/80",
    iconSurface: "border-white/[0.08] bg-white/[0.06] text-fg/72",
    rowActive: "bg-white/[0.08] text-fg/90",
    rowHover: "hover:bg-white/[0.055] hover:text-fg/90",
  },
};

export function PermissionModeGlyph({
  icon,
  size = 11,
  className,
}: {
  icon: PermissionModeIconKind;
  size?: number;
  className?: string;
}) {
  switch (icon) {
    case "manual":
      return <ShieldCheck size={size} weight="fill" className={className} />;
    case "auto":
      return <Lightning size={size} weight="fill" className={className} />;
    case "edit":
      return <PencilSimple size={size} weight="fill" className={className} />;
    case "plan":
      return <Strategy size={size} weight="fill" className={className} />;
    case "full":
      return <ShieldWarning size={size} weight="fill" className={className} />;
    case "config":
      return <GearSix size={size} weight="fill" className={className} />;
    case "agent":
      return <Desktop size={size} weight="fill" className={className} />;
    case "agi":
      return <RocketLaunch size={size} weight="fill" className={className} />;
  }
}

export function PermissionModePicker<Value extends string>({
  ariaLabel,
  selectedValue,
  options,
  disabled,
  onSelect,
  title,
}: {
  ariaLabel: string;
  selectedValue: Value;
  options: Array<PermissionModePickerOption<Value>>;
  disabled?: boolean;
  onSelect?: (value: Value) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0];
  const selectedTone = PERMISSION_MODE_TONE_STYLES[selectedOption?.tone ?? "slate"];

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-permission-mode-picker-dropdown]")) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (!selectedOption) return null;

  const triggerTitle = title ?? selectedOption.detail;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-state={open ? "open" : "closed"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || !onSelect}
        onClick={() => {
          if (disabled || !onSelect) return;
          setOpen((current) => !current);
        }}
        className={cn(
          PERMISSION_TRIGGER_CLASS,
          selectedTone.trigger,
          open && "ring-1 ring-white/[0.06]",
          (disabled || !onSelect) && "cursor-not-allowed opacity-60 hover:border-white/[0.06] hover:bg-white/[0.03]",
        )}
        title={triggerTitle}
      >
        <span className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", selectedTone.iconSurface)} aria-hidden>
          <PermissionModeGlyph icon={selectedOption.icon} size={9} />
        </span>
        <span className="ade-chat-composer-permission-label truncate font-medium leading-none">
          {selectedOption.triggerLabel ?? selectedOption.label}
        </span>
        <CaretDown
          size={10}
          weight="bold"
          className={cn(
            "ade-chat-composer-permission-chevron shrink-0 text-current/65 transition-transform duration-150",
            open && "rotate-180 text-current/90",
          )}
        />
      </button>
      {open && ref.current ? createPortal(
        (() => {
          const rect = ref.current.getBoundingClientRect();
          const width = PERMISSION_MODE_MENU_WIDTH;
          const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
          return (
            <div
              role="listbox"
              aria-label={ariaLabel}
              data-permission-mode-picker-dropdown
              className="fixed z-[100] overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
              style={{
                left,
                bottom: Math.max(8, window.innerHeight - rect.top + 8),
                width,
              }}
            >
              <ul className="py-0.5">
                {options.map((option) => {
                  const active = option.value === selectedValue;
                  const tone = PERMISSION_MODE_TONE_STYLES[option.tone];
                  return (
                    <li key={option.value}>
                      <button
                        type="button"
                        role="option"
                        aria-label={option.label}
                        aria-selected={active}
                        onClick={() => {
                          onSelect?.(option.value);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-sans transition-colors",
                          active ? tone.rowActive : "text-fg/72",
                          tone.rowHover,
                        )}
                        title={option.detail}
                      >
                        <span className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", tone.iconSurface)} aria-hidden>
                          <PermissionModeGlyph icon={option.icon} size={10} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*10/14)] font-semibold leading-4">
                          {option.label}
                        </span>
                        {active ? <Check size={12} weight="bold" className="shrink-0 opacity-80" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })(),
        document.body,
      ) : null}
    </div>
  );
}
