import { useState, type FormEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from "../../ui/paneMenuTokens";

/**
 * The drawer's vocabulary (§8): one section shape, one row shape, one
 * switch, one button, one input, one menu. Every section is built from these
 * so the nine of them read as one column rather than nine tools.
 *
 * Unsupported controls are DISABLED, never hidden: a switch whose value the
 * device did not report renders off and inert, so the drawer's shape is the
 * same on every simulator and a missing row never reads as a missing feature.
 */

export const DRAWER_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-border bg-transparent px-2",
  "text-[11px] font-medium text-fg/85 hover:bg-white/[0.06] hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_GHOST_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-transparent bg-transparent px-2",
  "text-[11px] font-medium text-muted-fg hover:bg-white/[0.06] hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_ICON_BUTTON = cn(
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border-0 bg-transparent",
  "text-muted-fg hover:bg-white/[0.06] hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);

export const DRAWER_INPUT = cn(
  "h-6 min-w-0 flex-1 rounded-[6px] border border-border bg-black/25 px-1.5",
  "text-[11px] text-fg/90 placeholder:text-muted-fg/50 outline-none",
  "focus:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

export function Section({
  title,
  right,
  children,
  testId,
}: {
  title: string;
  /** Header-right control, e.g. the Preview Lab `⋯`. */
  right?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0"
      data-testid={testId}
      aria-label={title}
    >
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-fg">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className={cn("shrink-0 text-xs text-muted-fg", mono && "font-mono")}>{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{children}</div>
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
        "relative h-[16px] w-[28px] shrink-0 rounded-full border transition-colors",
        on
          ? "border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
          : "border-white/[0.12] bg-white/[0.06]",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white/90 transition-all",
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
            "inline-flex h-6 min-w-0 max-w-[10.5rem] items-center gap-1 rounded-[6px] border border-border bg-transparent px-1.5",
            "text-[11px] font-medium text-fg/85 hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-40",
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
    <form className="flex min-h-7 items-center gap-1.5" onSubmit={submit}>
      <input
        className={cn(DRAWER_INPUT, mono && "font-mono")}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className={DRAWER_BUTTON} disabled={disabled || value.trim().length === 0}>
        {action}
      </button>
    </form>
  );
}
