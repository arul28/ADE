import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  Bell,
  CaretDown,
  CaretRight,
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

const SECTION_LABEL = cn("px-0.5 pb-1 pt-0.5", WORK_TOOL_SECTION_LABEL_TEXT);
const ROW = "flex items-center gap-1.5 px-0.5 py-[3px]";
const ROW_LABEL = "min-w-0 flex-1 truncate font-sans text-[11px] text-fg/72";
const SELECT = cn(
  "h-6 min-w-0 rounded border border-white/[0.08] bg-white/[0.04] px-1 font-sans text-[10px] text-fg/85",
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/40 disabled:cursor-not-allowed disabled:opacity-45",
);

/**
 * A select that renders dark.
 *
 * A native select paints its own popup from the document's colour scheme, and
 * the renderer does not declare one, so an unstyled select arrives light on a
 * dark panel. Stating it here keeps every option list in the column readable.
 */
function ToolSelect({
  ariaLabel,
  value,
  disabled,
  onChange,
  className,
  children,
}: {
  ariaLabel: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn(SELECT, className)}
      style={{ colorScheme: "dark" }}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
}
const BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded border border-white/[0.08] bg-white/[0.04] px-1.5",
  "font-sans text-[10px] font-medium text-fg/80 transition-colors hover:bg-white/[0.08]",
  "disabled:cursor-not-allowed disabled:opacity-45",
);
const INPUT = cn(
  "h-6 min-w-0 flex-1 rounded border border-white/[0.08] bg-white/[0.04] px-1.5 font-sans text-[10px] text-fg/85",
  "placeholder:text-muted-fg/45 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/40",
  "disabled:cursor-not-allowed disabled:opacity-45",
);

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
        checked ? "border-emerald-300/40 bg-emerald-500/40" : "border-white/[0.1] bg-white/[0.06]",
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
          <button type="button" className={cn(BUTTON, "mr-0.5 border-0 bg-transparent px-1")} onClick={onRefresh} disabled={busy} title="Re-read device settings">
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
          <ToolSelect
            ariaLabel="Appearance"
            className="w-[112px] shrink-0"
            value={appearance === "light" || appearance === "dark" ? appearance : ""}
            disabled={locked}
            onChange={(next) => onSetAppearance(next as IosSimulatorAppearance)}
          >
            {appearance === "light" || appearance === "dark" ? null : <option value="">Unknown</option>}
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </ToolSelect>
        </div>
        <div className={ROW}>
          <TextAa size={11} className="shrink-0 text-muted-fg/55" />
          <div className={ROW_LABEL}>Text size</div>
          <ToolSelect
            ariaLabel="Text size"
            className="w-[112px] shrink-0"
            value={settings?.contentSize ?? ""}
            disabled={locked}
            onChange={(next) => onSetContentSize(next as IosSimulatorContentSize)}
          >
            {settings && !IOS_SIMULATOR_CONTENT_SIZES.includes(settings.contentSize as IosSimulatorContentSize) ? (
              <option value={settings.contentSize}>{settings.contentSize}</option>
            ) : null}
            {IOS_SIMULATOR_CONTENT_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </ToolSelect>
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
          <ToolSelect
            ariaLabel="Location"
            className="flex-1"
            value=""
            disabled={locked}
            onChange={(next) => {
              const preset = LOCATION_PRESETS.find((item) => item.label === next);
              if (preset) onSetLocation(preset.latitude, preset.longitude);
            }}
          >
            <option value="">
              {settings?.location
                ? `${settings.location.latitude.toFixed(3)}, ${settings.location.longitude.toFixed(3)}`
                : "Not set"}
            </option>
            {LOCATION_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>{preset.label}</option>
            ))}
          </ToolSelect>
          <button type="button" className={BUTTON} onClick={onClearLocation} disabled={locked}>
            Clear
          </button>
        </div>
      </Section>

      <Section label="Permissions">
        <div className={ROW}>
          <ShieldCheck size={11} className="shrink-0 text-muted-fg/55" />
          <ToolSelect
            ariaLabel="Permission service"
            className="flex-1"
            value={permissionService}
            disabled={locked}
            onChange={(next) => setPermissionService(next as IosSimulatorPrivacyService)}
          >
            {IOS_SIMULATOR_PRIVACY_SERVICES.map((service) => (
              <option key={service} value={service}>{service}</option>
            ))}
          </ToolSelect>
        </div>
        <div className={cn(ROW, "gap-1")}>
          {(["grant", "revoke", "reset"] as IosSimulatorPrivacyAction[]).map((action) => (
            <button
              key={action}
              type="button"
              className={cn(BUTTON, "flex-1 justify-center")}
              disabled={locked || (!bundleId && action !== "reset")}
              title={!bundleId && action !== "reset" ? "Grant and revoke need an app session." : undefined}
              onClick={() => onSetPermission(action, permissionService)}
            >
              {action}
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
            disabled={busy}
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
