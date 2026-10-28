import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { createPortal } from "react-dom";
import { fixedMenuAboveAnchorStyle } from "../../lib/fixedMenuPlacement";
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
import { usePortalContainer } from "../ui/portalContainer";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";
import { toneText } from "../lanes/laneDesignTokens";

/**
 * The permission-mode pill from the chat composer, lifted into `shared/` so the
 * cross-machine handoff modal can render the exact same control.
 *
 * It used to live inside `AgentChatComposer.tsx` as a private component, which
 * is why the handoff modal shipped with a model picker and nothing else — there
 * was no permission control it could reach without duplicating one. Anything
 * that lets a user choose how a chat starts should render this, not a lookalike.
 */

const PERMISSION_MODE_MENU_WIDTH = 264;
const PERMISSION_MODE_ROW_HEIGHT = 32;
/** A menu whose top edge lands closer than this to the window's top flips below. */
const MENU_VIEWPORT_PAD = 8;

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
  "border-fg/[0.06] bg-fg/[0.03] text-fg/80",
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
    /**
     * Resting chrome for the collapsed trigger. Only a mode that can actually
     * hurt you earns colour out here: a toolbar where every control is a
     * saturated pill has no way left to say "this one is different", so the
     * safe modes inherit the neutral `PERMISSION_TRIGGER_CLASS` chrome and let
     * their tone read from the glyph alone. The full tone palette still applies
     * inside the open popover, where there is room to differentiate.
     */
    trigger: string;
    /** Space-separated RGB for the sliding highlight and the header word. */
    rgb: string;
    iconSurface: string;
    rowActive: string;
    rowHover: string;
  }
> = {
  green: {
    rgb: "52 211 153",
    dot: "bg-emerald-400",
    trigger: "",
    iconSurface: "border-emerald-300/20 bg-emerald-500/[0.12] text-emerald-200",
    rowActive: "bg-emerald-500/[0.12] text-emerald-50",
    rowHover: "hover:bg-emerald-500/[0.08] hover:text-emerald-50",
  },
  amber: {
    rgb: "251 191 36",
    dot: "bg-amber-400",
    trigger: "",
    iconSurface: "border-amber-300/20 bg-amber-500/[0.12] text-amber-200",
    rowActive: "bg-amber-500/[0.12] text-amber-50",
    rowHover: "hover:bg-amber-500/[0.08] hover:text-amber-50",
  },
  blue: {
    rgb: "56 189 248",
    dot: "bg-sky-400",
    trigger: "",
    iconSurface: "border-sky-300/20 bg-sky-500/[0.12] text-sky-200",
    rowActive: "bg-sky-500/[0.12] text-sky-50",
    rowHover: "hover:bg-sky-500/[0.08] hover:text-sky-50",
  },
  purple: {
    rgb: "167 139 250",
    dot: "bg-violet-400",
    trigger: "",
    iconSurface: "border-violet-300/20 bg-violet-500/[0.14] text-violet-200",
    rowActive: "bg-violet-500/[0.14] text-violet-50",
    rowHover: "hover:bg-violet-500/[0.08] hover:text-violet-50",
  },
  red: {
    rgb: "248 113 113",
    dot: "bg-red-400",
    // The one tone that keeps colour in the toolbar — bypassed permissions are
    // the only setting here that can do damage. It is a tint, not a filled
    // pill: enough to catch the eye without shouting over the send button.
    trigger: "border-red-400/25 text-red-100/90",
    iconSurface: "border-red-300/20 bg-red-500/[0.14] text-red-200",
    rowActive: "bg-red-500/[0.14] text-red-50",
    rowHover: "hover:bg-red-500/[0.08] hover:text-red-50",
  },
  slate: {
    rgb: "161 161 170",
    dot: "bg-slate-300",
    trigger: "",
    iconSurface: "border-fg/[0.08] bg-fg/[0.06] text-fg/72",
    rowActive: "bg-fg/[0.08] text-fg/90",
    rowHover: "hover:bg-fg/[0.055] hover:text-fg/90",
  },
};

/** A tone as space-separated RGB, for tinted fills that match the open menu. */
export function permissionModeToneRgb(tone: PermissionModeTone): string {
  return PERMISSION_MODE_TONE_STYLES[tone].rgb;
}

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
  // Opens above the pill (it lives in toolbars at the bottom of a composer or a
  // dialog); flips below when the window has no room above it.
  const [below, setBelow] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Inside a dialog the list portals into it: a modal dialog blocks pointer
  // events and focus everywhere outside its content.
  const portalContainer = usePortalContainer();
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

  useLayoutEffect(() => {
    if (!open) {
      setBelow(false);
      return;
    }
    const menu = menuRef.current;
    const anchor = ref.current;
    if (below || !menu || !anchor) return;
    const menuTop = menu.getBoundingClientRect().top;
    const anchorRect = anchor.getBoundingClientRect();
    const roomBelow = window.innerHeight - anchorRect.bottom;
    if (menuTop < MENU_VIEWPORT_PAD && roomBelow > anchorRect.top) setBelow(true);
  }, [open, below]);

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
          open && "ring-1 ring-fg/[0.06]",
          (disabled || !onSelect) && "cursor-not-allowed opacity-60 hover:border-fg/[0.06] hover:bg-fg/[0.03]",
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
          const anchor = ref.current;
          if (!anchor) return null;
          const rect = anchor.getBoundingClientRect();
          return (
            <ViewportOverlayHost layer="popover">
              <PermissionModeMenu
                menuRef={menuRef}
                ariaLabel={ariaLabel}
                options={options}
                selectedValue={selectedValue}
                style={{
                  ...fixedMenuAboveAnchorStyle(rect, { width: PERMISSION_MODE_MENU_WIDTH, below }),
                  pointerEvents: "auto",
                }}
                onSelect={(value) => {
                  onSelect?.(value);
                  setOpen(false);
                }}
              />
            </ViewportOverlayHost>
          );
        })(),
        portalContainer ?? document.body,
      ) : null}
    </div>
  );
}

/**
 * The open list, in the effort picker's style: a header naming the mode, a
 * recessed track of modes with one highlight that slides to the row under the
 * pointer (or keyboard focus) in that mode's tone, and a line describing it.
 * The modes are not a scale, so the track runs down rather than across, which
 * also leaves room for full names. The highlight moves by transform only.
 */
function PermissionModeMenu<Value extends string>({
  menuRef,
  ariaLabel,
  options,
  selectedValue,
  style,
  onSelect,
}: {
  ariaLabel: string;
  options: Array<PermissionModePickerOption<Value>>;
  selectedValue: Value;
  style: React.CSSProperties;
  onSelect: (value: Value) => void;
  menuRef?: React.Ref<HTMLDivElement>;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
  const [pointedIndex, setPointedIndex] = useState<number | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const shownIndex = pointedIndex ?? selectedIndex;
  const shown = options[shownIndex] ?? options[0];
  const selected = options[selectedIndex] ?? options[0];
  const shownTone = PERMISSION_MODE_TONE_STYLES[shown?.tone ?? "slate"];
  const selectedTone = PERMISSION_MODE_TONE_STYLES[selected?.tone ?? "slate"];

  // Focus the current mode once, as the menu opens; a later pick closes it.
  const openedOnIndexRef = useRef(selectedIndex);
  useEffect(() => {
    const frame = requestAnimationFrame(() => optionRefs.current[openedOnIndexRef.current]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const moveFocus = (index: number) => {
    const next = (index + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(options.length - 1);
    }
  };

  if (!shown || !selected) return null;

  return (
    <div
      ref={menuRef}
      data-permission-mode-picker-dropdown
      className={cn("absolute overflow-hidden rounded-2xl p-2.5", POPOVER_SURFACE_CLASS)}
      style={style}
    >
      <div className="flex items-center gap-2 px-1 pb-2.5 pt-0.5 font-sans text-[12px] leading-none text-muted-fg/72">
        <span
          aria-hidden
          className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", selectedTone.iconSurface)}
        >
          <PermissionModeGlyph icon={selected.icon} size={9} />
        </span>
        <span>Permissions</span>
        <span className="truncate font-semibold" style={{ color: toneText(`rgb(${selectedTone.rgb})`) }}>
          {selected.triggerLabel ?? selected.label}
        </span>
      </div>
      <div
        role="listbox"
        aria-label={ariaLabel}
        className="relative rounded-xl bg-black/25 p-[3px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
        onMouseLeave={() => setPointedIndex(null)}
      >
        <div
          aria-hidden
          className="ade-permission-mode-highlight pointer-events-none absolute inset-x-[3px] top-[3px] rounded-lg"
          style={{
            height: PERMISSION_MODE_ROW_HEIGHT,
            transform: `translateY(${shownIndex * PERMISSION_MODE_ROW_HEIGHT}px)`,
            "--permission-mode-rgb": shownTone.rgb,
          } as React.CSSProperties}
        />
        {options.map((option, index) => {
          const active = option.value === selectedValue;
          const tone = PERMISSION_MODE_TONE_STYLES[option.tone];
          const lit = index === shownIndex;
          return (
            <button
              key={option.value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="option"
              aria-label={option.label}
              aria-selected={active}
              tabIndex={index === selectedIndex ? 0 : -1}
              onClick={() => onSelect(option.value)}
              onMouseEnter={() => setPointedIndex(index)}
              onFocus={() => setPointedIndex(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "relative z-[1] flex w-full items-center gap-2 rounded-lg px-2 text-left font-sans outline-none transition-colors duration-150",
                lit ? "text-fg" : "text-fg/65",
              )}
              style={{ height: PERMISSION_MODE_ROW_HEIGHT }}
              title={option.detail}
            >
              <span
                aria-hidden
                className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", tone.iconSurface)}
              >
                <PermissionModeGlyph icon={option.icon} size={10} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4">
                {option.label}
              </span>
              {active ? <Check aria-hidden size={12} weight="bold" className="shrink-0 opacity-80" /> : null}
            </button>
          );
        })}
      </div>
      <p className="mt-2.5 min-h-8 px-1 font-sans text-[11px] leading-4 text-muted-fg/65">
        {shown.detail}
      </p>
    </div>
  );
}
