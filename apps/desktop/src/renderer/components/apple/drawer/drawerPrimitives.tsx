import { useState, type FormEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from "../../ui/paneMenuTokens";

/**
 * The drawer's vocabulary (round 4 §B2): one GROUP card, one row shape, one
 * switch, one button, one input, one menu. Four groups are built from these, so
 * the column reads as four cards rather than nine stacked tools.
 *
 * Round 3's version drew a hairline box around every single control — every
 * button, every input, every menu trigger, the appearance pair — on a flat
 * transparent column. At nine sections that is roughly forty outlines in one
 * scroll, which is the "spam of info with no prior organisation" the owner
 * reported. The rule here is the inverse: the CARD carries the edge, the
 * controls carry a fill, and the only accent in a group is its one primary
 * verb (or a switch that is on).
 *
 * Unsupported controls are DISABLED, never hidden: a switch whose value the
 * device did not report renders off and inert, so the drawer's shape is the
 * same on every simulator and a missing row never reads as a missing feature.
 */

/**
 * The control fill, as a tint of the foreground rather than white.
 *
 * `bg-white/[0.06]` is invisible on the light theme's white card — it was
 * readable in round 3 only because the drawer was dark-only in practice. A
 * `--color-fg` mix darkens on light and lightens on dark, which is the same
 * control in both.
 */
const FILL = "bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]";
const FILL_HOVER = "hover:bg-[color-mix(in_srgb,var(--color-fg)_12%,transparent)]";
const ACCENT_FILL = "bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]";
const ACCENT_FILL_HOVER = "hover:bg-[color-mix(in_srgb,var(--color-accent)_32%,transparent)]";

export const DRAWER_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border-0 px-2",
  FILL,
  FILL_HOVER,
  "text-[11px] font-medium text-fg/85 hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);

/**
 * The one verb a group is FOR — Set, Open, Launch, Send, Grant, Render.
 *
 * Exactly one accent control per group at a time is the whole point of it: an
 * accent on every button is the same as an accent on none.
 */
export const DRAWER_PRIMARY_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border-0 px-2",
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  "text-[11px] font-semibold text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_GHOST_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border-0 bg-transparent px-2",
  "text-[11px] font-medium text-muted-fg hover:text-fg",
  FILL_HOVER,
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_ICON_BUTTON = cn(
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border-0 bg-transparent",
  "text-muted-fg hover:text-fg",
  FILL_HOVER,
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_INPUT = cn(
  "h-6 min-w-0 flex-1 rounded-[6px] border-0 px-1.5",
  FILL,
  "text-[11px] text-fg/90 placeholder:text-muted-fg/50 outline-none",
  "focus:ring-1 focus:ring-[color-mix(in_srgb,var(--color-accent)_55%,transparent)]",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

/** The four groups, in the order the drawer stacks them (§B1). */
export const APPLE_DRAWER_GROUPS = ["device", "app", "capture", "preview-lab"] as const;

export type AppleDrawerGroupId = (typeof APPLE_DRAWER_GROUPS)[number];

export function isAppleDrawerGroupId(value: unknown): value is AppleDrawerGroupId {
  return typeof value === "string" && (APPLE_DRAWER_GROUPS as readonly string[]).includes(value);
}

/**
 * One collapsible group card.
 *
 * The header is the whole hit area, because a 14px caret is not a target — and
 * it is a `<button>` rather than `<details>`/`<summary>` so the accordion can
 * be driven from the outside: only one group is open at a time, and the drawer
 * owns which.
 *
 * The body is UNMOUNTED when closed, not hidden. Three of the four groups poll
 * the device (settings, the foreground app, the event log, the preview list)
 * and a hidden group that keeps polling is four timers running for a card you
 * cannot see.
 */
export function Group({
  id,
  title,
  open,
  onToggle,
  right,
  children,
  testId,
}: {
  id: AppleDrawerGroupId;
  title: string;
  open: boolean;
  onToggle: (id: AppleDrawerGroupId) => void;
  /** Header-right control, e.g. Preview Lab's `⋯`. Only drawn while open. */
  right?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col overflow-hidden"
      data-open={open ? "true" : "false"}
      data-testid={testId}
      aria-label={title}
    >
      <div className="flex min-h-9 min-w-0 flex-nowrap items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(id)}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] px-3 text-left"
        >
          <h3 className={cn("min-w-0 flex-1 truncate text-xs font-medium", open ? "text-fg" : "text-muted-fg")}>
            {title}
          </h3>
          <CaretDown
            size={11}
            weight="bold"
            aria-hidden="true"
            className={cn("shrink-0 text-muted-fg/70 transition-transform", open && "rotate-180")}
          />
        </button>
        {open ? right : null}
      </div>
      {open ? <div className="flex min-w-0 flex-col gap-2 px-3 pb-3">{children}</div> : null}
    </section>
  );
}

/**
 * A group's internal divider: the name of the thing the next rows act on.
 *
 * Muted, small and not a heading element — the GROUP owns the only `h3` in its
 * card, so a screen reader hears four sections rather than nine.
 */
export function Subhead({ label }: { label: string }) {
  return (
    <div className="mt-1 min-w-0 truncate border-t border-border/50 pt-2 text-[10px] font-medium uppercase tracking-[0.07em] text-muted-fg/70">
      {label}
    </div>
  );
}

/**
 * One row: a label, and its control on the right of the SAME line (§B4).
 *
 * The label is the part that gives way. Round 2 made it `shrink-0` and let the
 * control column shrink instead, so on a narrow drawer "Reduce Transparency"
 * held its full width and pushed the switch off the edge — the collision in
 * the screenshot. Reversed: the control is `shrink-0` (a 28px switch has no
 * smaller size to go to), the label truncates with its full text in `title`,
 * and `flex-nowrap` means neither of them can ever drop to a second line.
 */
export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-7 min-w-0 flex-nowrap items-center justify-between gap-3">
      <span
        title={label}
        className={cn("min-w-0 flex-1 truncate text-xs text-muted-fg", mono && "font-mono")}
      >
        {label}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-1.5">{children}</div>
    </div>
  );
}

export function DrawerSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  /** `undefined` = the device did not report this setting: rendered off and disabled. */
  checked: boolean | undefined;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const unsupported = checked === undefined;
  const on = checked === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || unsupported}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-[16px] w-[28px] shrink-0 rounded-full border-0 transition-colors",
        on
          ? "bg-[color-mix(in_srgb,var(--color-accent)_62%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--color-fg)_14%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white/90 transition-all",
          on ? "left-[14px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export function SwitchRow(props: {
  label: string;
  checked: boolean | undefined;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Row label={props.label}>
      <DrawerSwitch {...props} />
    </Row>
  );
}

/**
 * Two or three exclusive values on one line — Appearance, and anything else
 * small enough to show every option at once.
 *
 * One fill for the track, accent for the selected segment, no per-segment
 * outline: the group of them is the control, not three buttons that happen to
 * be adjacent.
 */
export function DrawerSegmented<T extends string>({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex shrink-0 overflow-hidden rounded-[6px]", FILL)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => { if (!active) onChange(option.value); }}
            className={cn(
              "h-6 border-0 px-2 text-[11px] font-medium disabled:pointer-events-none disabled:opacity-40",
              active
                ? cn(ACCENT_FILL, "text-fg")
                : cn("text-muted-fg hover:text-fg", FILL_HOVER),
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type DrawerMenuOption<T extends string> = { value: T; label: string; group?: string };

/**
 * One value picker. Radix, not a native `<select>`, so the popup wears the
 * pane's own surface. Generic over the value so a caller keeps its union.
 */
export function DrawerMenu<T extends string>({
  ariaLabel,
  value,
  placeholder,
  options,
  disabled,
  onChange,
  className,
}: {
  ariaLabel: string;
  value: T | null;
  placeholder: string;
  options: readonly DrawerMenuOption<T>[];
  disabled: boolean;
  onChange: (value: T) => void;
  className?: string;
}) {
  const current = options.find((option) => option.value === value) ?? null;
  const groups = new Map<string, DrawerMenuOption<T>[]>();
  for (const option of options) {
    const key = option.group ?? "";
    const list = groups.get(key) ?? [];
    list.push(option);
    groups.set(key, list);
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "inline-flex h-6 min-w-0 max-w-[10.5rem] items-center gap-1 rounded-[6px] border-0 px-1.5",
            FILL,
            FILL_HOVER,
            "text-[11px] font-medium text-fg/85 disabled:pointer-events-none disabled:opacity-40",
            className,
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate text-left", !current && "text-muted-fg")}>
            {current?.label ?? placeholder}
          </span>
          <CaretDown size={9} weight="bold" aria-hidden="true" className="shrink-0 text-muted-fg/70" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} className={MENU_CONTENT_CLASS}>
          <DropdownMenu.RadioGroup
            value={value ?? ""}
            onValueChange={(next) => {
              const option = options.find((item) => item.value === next);
              if (option && option.value !== value) onChange(option.value);
            }}
          >
            {[...groups.entries()].map(([group, items]) => (
              <DropdownMenu.Group key={group || "__ungrouped"}>
                {group ? <DropdownMenu.Label className={MENU_LABEL_CLASS}>{group}</DropdownMenu.Label> : null}
                {items.map((option) => (
                  <DropdownMenu.RadioItem key={option.value} value={option.value} className={MENU_ITEM_CLASS}>
                    <Check
                      size={11}
                      weight="bold"
                      aria-hidden="true"
                      className={cn("shrink-0 text-[var(--color-accent)]", option.value === value ? "opacity-100" : "opacity-0")}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{option.label}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** An input and its one verb. Submits on Enter or the button; clears on success. */
export function SubmitRow({
  placeholder,
  action,
  disabled,
  onSubmit,
  mono = true,
  ariaLabel,
}: {
  placeholder: string;
  action: string;
  disabled: boolean;
  /** Resolves true when the value was accepted, so the field can clear. */
  onSubmit: (value: string) => Promise<boolean>;
  mono?: boolean;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState("");
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    void onSubmit(trimmed).then((accepted) => {
      if (accepted) setValue("");
    });
  };
  return (
    <form className="flex min-h-7 min-w-0 flex-nowrap items-center gap-1.5" onSubmit={submit}>
      <input
        className={cn(DRAWER_INPUT, mono && "font-mono")}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className={DRAWER_PRIMARY_BUTTON} disabled={disabled || value.trim().length === 0}>
        {action}
      </button>
    </form>
  );
}
