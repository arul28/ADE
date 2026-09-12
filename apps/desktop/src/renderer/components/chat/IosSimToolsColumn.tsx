import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowClockwise,
  Bell,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  Crosshair,
  Link as LinkIcon,
  ShieldCheck,
  Stop,
  TextAa,
} from "@phosphor-icons/react";
import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
  IosSimulatorDeviceSettings,
  IosSimulatorLogRow,
  IosSimulatorPrivacyAction,
  IosSimulatorPrivacyService,
} from "../../../shared/types/iosSimulator";
import {
  IOS_SIMULATOR_ACCESSIBILITY_OPTIONS,
  IOS_SIMULATOR_CONTENT_SIZES,
  IOS_SIMULATOR_PRIVACY_SERVICES,
} from "../../../shared/types/iosSimulator";
import { WORK_TOOL_SECTION_LABEL_TEXT } from "../terminals/workToolChrome";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
} from "../ui/paneMenuTokens";
import { cn } from "../ui/cn";

/**
 * Device state as typed controls instead of a trip through Settings.
 *
 * Every control here maps to one `simctl` call on the machine that owns the
 * simulator, so it works the same from a remote runtime as it does locally.
 * Setting a value is also the reproducible thing: each change writes a row in
 * the event log carrying the `ade ios-sim` command that repeats it.
 */

const ACCESSIBILITY_LABELS: Record<IosSimulatorAccessibilityOption, string> = {
  "increase-contrast": "Increase contrast",
  "reduce-motion": "Reduce motion",
  "reduce-transparency": "Reduce transparency",
  "bold-text": "Bold text",
  "invert-colors": "Invert colours",
  grayscale: "Greyscale",
  "voice-over": "VoiceOver",
};

/** Somewhere to stand when a bug report says "it breaks outside the office". */
const LOCATION_PRESETS: { label: string; latitude: number; longitude: number }[] = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5072, longitude: -0.1276 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { label: "Sydney", latitude: -33.8688, longitude: 151.2093 },
];

/**
 * The three privacy actions, written the way every other button in the column
 * is. `simctl` spells them lower case; a control does not have to.
 */
const PERMISSION_ACTION_LABELS: Record<IosSimulatorPrivacyAction, string> = {
  grant: "Grant",
  revoke: "Revoke",
  reset: "Reset",
};

const SECTION_LABEL = cn("px-0.5 pb-1 pt-0.5", WORK_TOOL_SECTION_LABEL_TEXT);
const ROW = "flex items-center gap-1.5 px-0.5 py-[3px]";
const ROW_LABEL = "min-w-0 flex-1 truncate font-sans text-[11px] text-fg/72";

/**
 * Every clickable thing in the column wears the pane's own control skin.
 *
 * `.ade-shell-control` already owns the fill, border, radius, hover and
 * `data-[state=open]` paint that the browser pane next door spends, so the
 * column states only its size. Hand-written border and background utilities
 * were how this column drifted into a third look in the first place.
 */
const CONTROL = "ade-shell-control disabled:cursor-not-allowed disabled:opacity-45";
const BUTTON = cn(
  CONTROL,
  "inline-flex h-6 shrink-0 items-center gap-1 px-2 font-sans text-[10px] font-medium",
);

/**
 * A menu trigger reads as the value it carries, not as a form field.
 *
 * Same height and type as the buttons beside it, so a row of a value and an
 * action does not look like two different kinds of control.
 */
const MENU_TRIGGER = cn(
  CONTROL,
  "inline-flex h-6 min-w-0 items-center gap-1 px-1.5 font-sans text-[10px] font-medium",
);

/** The browser pane's field: a sunken well rather than a raised control. */
const INPUT = cn(
  "h-6 min-w-0 flex-1 rounded-[5px] border border-white/[0.08] bg-black/25 px-1.5",
  "font-sans text-[10.5px] text-fg/85 placeholder:text-muted-fg/45 outline-none",
  "focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
  "disabled:cursor-not-allowed disabled:opacity-45",
);

type ToolMenuOption = { value: string; label: string };

/**
 * One value picker for the whole column.
 *
 * A native `<select>` paints its popup from the document's colour scheme and
 * lands as a third visual language beside the browser pane's Radix menus, so
 * the list is the house menu instead: same surface, same item metrics, same
 * accent check mark on whatever is on.
 */
function ToolMenu({
  ariaLabel,
  value,
  placeholder,
  options,
  disabled,
  onChange,
  className,
}: {
  ariaLabel: string;
  value: string;
  /** Shown on the trigger when the current value is not one of the options. */
  placeholder: string;
  options: ToolMenuOption[];
  disabled: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(MENU_TRIGGER, className)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? placeholder}</span>
          <CaretDown size={9} weight="bold" aria-hidden="true" className="shrink-0 text-muted-fg/60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={MENU_CONTENT_CLASS}
        >
          <DropdownMenu.Label className={MENU_LABEL_CLASS}>{ariaLabel}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className={MENU_ITEM_CLASS}
              >
                <Check
                  size={11}
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    "shrink-0 text-[var(--color-accent)]",
                    option.value === value ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[14px] w-[24px] shrink-0 rounded-full border transition-colors",
        // Accent, not a hard-coded green: on means on everywhere in the pane.
        checked
          ? cn(
            "border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]",
            "bg-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]",
          )
          : "border-white/[0.1] bg-white/[0.06]",
        "disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      <span
        className={cn(
          "absolute top-[1px] h-[10px] w-[10px] rounded-full bg-white/85 transition-all",
          checked ? "left-[12px]" : "left-[1px]",
        )}
      />
    </button>
  );
}

function Section({
  label,
  children,
  right,
}: {
  label: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="border-b border-white/[0.05] pb-1.5 last:border-b-0">
      <div className="flex items-center justify-between">
        <div className={SECTION_LABEL}>{label}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export type IosSimToolsColumnProps = {
  settings: IosSimulatorDeviceSettings | null;
  /** The bundle id of the app in the active session, when there is one. */
  bundleId: string | null;
  appRunning: boolean | null;
  busy: boolean;
  /** True when another chat owns the session, so nothing here may mutate. */
  disabled: boolean;
  logRows: IosSimulatorLogRow[];
  logRunning: boolean;
  /** Rows the service dropped from its ring. Shown so a gap is never silent. */
  logDropped: number;
  /** What the log stream last said about itself, when it said anything. */
  logError: string | null;
  className?: string;
  onSetAppearance: (appearance: IosSimulatorAppearance) => void;
  onSetContentSize: (contentSize: IosSimulatorContentSize) => void;
  onSetAccessibility: (option: IosSimulatorAccessibilityOption, enabled: boolean) => void;
  onSetLocation: (latitude: number, longitude: number) => void;
  onClearLocation: () => void;
  onSetPermission: (action: IosSimulatorPrivacyAction, service: IosSimulatorPrivacyService) => void;
  onSendPush: (title: string, body: string) => void;
  onOpenUrl: (url: string) => void;
  onRelaunchApp: () => void;
  onTerminateApp: () => void;
  onToggleLog: () => void;
  onCopy: (text: string) => void;
  onRefresh: () => void;
};

export function IosSimToolsColumn({
  settings,
  bundleId,
  appRunning,
  busy,
  disabled,
  logRows,
  logRunning,
  logDropped,
  logError,
  className,
  onSetAppearance,
  onSetContentSize,
  onSetAccessibility,
  onSetLocation,
  onClearLocation,
  onSetPermission,
  onSendPush,
  onOpenUrl,
  onRelaunchApp,
  onTerminateApp,
  onToggleLog,
  onCopy,
  onRefresh,
}: IosSimToolsColumnProps) {
  const [url, setUrl] = useState("");
  const [pushTitle, setPushTitle] = useState("");
  const [pushBody, setPushBody] = useState("");
  // `photos`, not `camera`: `simctl privacy` has no camera service, and a
  // default the device rejects turns the first click into an error.
  const [permissionService, setPermissionService] = useState<IosSimulatorPrivacyService>("photos");
  const [logOpen, setLogOpen] = useState(false);

  // Starting the log is a request to read it. Leaving the rows collapsed made
  // Start look like it had done nothing.
  useEffect(() => {
    if (logRunning) setLogOpen(true);
  }, [logRunning]);

  const locked = disabled || busy;
  const appearance = settings?.appearance ?? "unknown";
  const accessibility = settings?.accessibility ?? null;

  const contentSize = settings?.contentSize ?? "";
  // A device can answer with a size this build has no name for. Listing it
  // keeps the trigger honest rather than showing a value with no row behind it.
  const contentSizeOptions: ToolMenuOption[] = [
    ...(contentSize && !IOS_SIMULATOR_CONTENT_SIZES.includes(contentSize as IosSimulatorContentSize)
      ? [{ value: contentSize, label: contentSize }]
      : []),
    ...IOS_SIMULATOR_CONTENT_SIZES.map((size) => ({ value: size, label: size })),
  ];

  const locationLabel = settings?.location
    ? `${settings.location.latitude.toFixed(3)}, ${settings.location.longitude.toFixed(3)}`
    : "Not set";

  return (
    <div
      className={cn(
        "flex w-[240px] shrink-0 flex-col gap-0 overflow-y-auto rounded border border-white/[0.08] bg-white/[0.02] p-1.5",
        className,
      )}
      data-testid="ios-tools-column"
    >
      <Section
        label="App"
        right={(
          <button type="button" data-variant="ghost" className={cn(BUTTON, "mr-0.5 px-1")} onClick={onRefresh} disabled={busy} title="Re-read device settings">
            <ArrowClockwise size={11} />
          </button>
        )}
      >
        <div className={ROW}>
          <div className={cn(ROW_LABEL, "font-mono text-[10px]")} title={bundleId ?? undefined}>
            {bundleId ?? "No app session"}
          </div>
          {bundleId ? (
            <button type="button" className={cn(BUTTON, "px-1")} onClick={() => onCopy(bundleId)} title="Copy the bundle id">
              <Copy size={10} />
            </button>
          ) : null}
        </div>
        {bundleId ? (
          <div className={ROW}>
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                appRunning === null ? "bg-muted-fg/40" : appRunning ? "bg-emerald-400/80" : "bg-muted-fg/40",
              )}
            />
            <div className={ROW_LABEL}>{appRunning === null ? "State unknown" : appRunning ? "Running" : "Not running"}</div>
            <button type="button" className={BUTTON} onClick={onRelaunchApp} disabled={locked}>
              Relaunch
            </button>
            <button type="button" className={cn(BUTTON, "px-1")} onClick={onTerminateApp} disabled={locked} title="Terminate the app">
              <Stop size={10} />
            </button>
          </div>
        ) : null}
        <div className={ROW}>
          <LinkIcon size={11} className="shrink-0 text-muted-fg/55" />
          <input
            className={INPUT}
            placeholder="ade://open"
            value={url}
            disabled={locked}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !url.trim()) return;
              onOpenUrl(url.trim());
            }}
          />
          <button type="button" className={BUTTON} disabled={locked || !url.trim()} onClick={() => onOpenUrl(url.trim())}>
            Open
          </button>
        </div>
      </Section>

      <Section label="Appearance">
        <div className={ROW}>
          <div className={ROW_LABEL}>Mode</div>
          <ToolMenu
            ariaLabel="Appearance"
            className="w-[112px] shrink-0"
            value={appearance === "light" || appearance === "dark" ? appearance : ""}
            placeholder="Unknown"
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            disabled={locked}
            onChange={(next) => onSetAppearance(next as IosSimulatorAppearance)}
          />
        </div>
        <div className={ROW}>
          <TextAa size={11} className="shrink-0 text-muted-fg/55" />
          <div className={ROW_LABEL}>Text size</div>
          <ToolMenu
            ariaLabel="Text size"
            className="w-[112px] shrink-0"
            value={contentSize}
            placeholder="Unknown"
            options={contentSizeOptions}
            disabled={locked}
            onChange={(next) => onSetContentSize(next as IosSimulatorContentSize)}
          />
        </div>
      </Section>

      <Section label="Accessibility">
        {IOS_SIMULATOR_ACCESSIBILITY_OPTIONS.map((option) => {
          const value = accessibility?.[option] ?? null;
          return (
            <div key={option} className={ROW}>
              <div className={ROW_LABEL}>{ACCESSIBILITY_LABELS[option]}</div>
              {value === null ? (
                <span className="shrink-0 font-sans text-[10px] text-muted-fg/45">n/a</span>
              ) : (
                <Toggle
                  checked={value}
                  disabled={locked}
                  label={ACCESSIBILITY_LABELS[option]}
                  onChange={(next) => onSetAccessibility(option, next)}
                />
              )}
            </div>
          );
        })}
      </Section>

      <Section label="Location">
        <div className={ROW}>
          <Crosshair size={11} className="shrink-0 text-muted-fg/55" />
          {/*
            The trigger carries the fix the device reports, which is never one
            of the presets, so nothing in the list is ever the checked row.
          */}
          <ToolMenu
            ariaLabel="Location"
            className="flex-1"
            value=""
            placeholder={locationLabel}
            options={LOCATION_PRESETS.map((preset) => ({ value: preset.label, label: preset.label }))}
            disabled={locked}
            onChange={(next) => {
              const preset = LOCATION_PRESETS.find((item) => item.label === next);
              if (preset) onSetLocation(preset.latitude, preset.longitude);
            }}
          />
          <button type="button" className={BUTTON} onClick={onClearLocation} disabled={locked}>
            Clear
          </button>
        </div>
      </Section>

      <Section label="Permissions">
        <div className={ROW}>
          <ShieldCheck size={11} className="shrink-0 text-muted-fg/55" />
          <ToolMenu
            ariaLabel="Permission service"
            className="flex-1"
            value={permissionService}
            placeholder="Pick a service"
            options={IOS_SIMULATOR_PRIVACY_SERVICES.map((service) => ({ value: service, label: service }))}
            disabled={locked}
            onChange={(next) => setPermissionService(next as IosSimulatorPrivacyService)}
          />
        </div>
        <div className={cn(ROW, "gap-1")}>
          {(["grant", "revoke", "reset"] as IosSimulatorPrivacyAction[]).map((action) => (
            <button
              key={action}
              type="button"
              className={cn(BUTTON, "flex-1 justify-center px-1")}
              disabled={locked || (!bundleId && action !== "reset")}
              title={!bundleId && action !== "reset" ? "Grant and revoke need an app session." : undefined}
              onClick={() => onSetPermission(action, permissionService)}
            >
              {PERMISSION_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      </Section>

      <Section label="Push">
        <div className={ROW}>
          <Bell size={11} className="shrink-0 text-muted-fg/55" />
          <input
            className={INPUT}
            placeholder="Title"
            value={pushTitle}
            disabled={locked || !bundleId}
            onChange={(event) => setPushTitle(event.target.value)}
          />
        </div>
        <div className={ROW}>
          <input
            className={INPUT}
            placeholder="Body"
            value={pushBody}
            disabled={locked || !bundleId}
            onChange={(event) => setPushBody(event.target.value)}
          />
          <button
            type="button"
            className={BUTTON}
            disabled={locked || !bundleId || (!pushTitle.trim() && !pushBody.trim())}
            onClick={() => onSendPush(pushTitle.trim(), pushBody.trim())}
          >
            Send
          </button>
        </div>
      </Section>

      <Section
        label={`Event log (${logRows.length})`}
        right={(
          <button
            type="button"
            className={cn(BUTTON, "mr-0.5")}
            onClick={onToggleLog}
            // The log follows one app, because `log stream` otherwise reads the
            // whole device. Stopping needs no bundle id, so only the start is
            // gated on one. `locked` is here as well as in the service: the
            // service rejects a chat that does not own the session, and this
            // stops the control from offering a call that cannot succeed.
            disabled={locked || (!logRunning && !bundleId)}
          >
            {logRunning ? "Stop" : "Start"}
          </button>
        )}
      >
        <button
          type="button"
          className={cn(ROW, "w-full text-left")}
          onClick={() => setLogOpen((open) => !open)}
        >
          {logOpen ? <CaretDown size={11} className="shrink-0 text-muted-fg/55" /> : <CaretRight size={11} className="shrink-0 text-muted-fg/55" />}
          <div className={ROW_LABEL}>{logOpen ? "Hide rows" : "Show rows"}</div>
        </button>
        {logOpen ? (
          <div className="max-h-48 overflow-y-auto px-0.5" data-testid="ios-event-log">
            {logError ? (
              <div className="py-1 font-sans text-[10px] text-rose-200/70">{logError}</div>
            ) : null}
            {logDropped > 0 ? (
              <div className="py-1 font-sans text-[10px] text-amber-200/60">
                {logDropped} earlier {logDropped === 1 ? "row" : "rows"} dropped.
              </div>
            ) : null}
            {logRows.length === 0 ? (
              <div className="py-1 font-sans text-[10px] text-muted-fg/45">No rows yet.</div>
            ) : (
              logRows.map((row) => (
                <div key={row.id} className="group flex items-start gap-1 py-[2px]">
                  <span
                    className={cn(
                      "mt-[4px] h-1 w-1 shrink-0 rounded-full",
                      row.source === "ade"
                        ? "bg-cyan-300/70"
                        : row.level === "error" || row.level === "fault"
                          ? "bg-rose-400/70"
                          : "bg-white/25",
                    )}
                  />
                  <div className="min-w-0 flex-1 break-words font-mono text-[9px] leading-[1.35] text-fg/62">
                    {row.message}
                  </div>
                  {row.command ? (
                    <button
                      type="button"
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title={`Copy: ${row.command}`}
                      onClick={() => onCopy(row.command ?? "")}
                    >
                      <Copy size={9} className="text-muted-fg/60" />
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </Section>
    </div>
  );
}
