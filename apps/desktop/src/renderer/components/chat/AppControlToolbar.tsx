import { type ReactNode } from "react";
import {
  AppWindow,
  DotsThree,
  Link as LinkIcon,
  Play,
  SpinnerGap,
  Wrench,
} from "@phosphor-icons/react";
import type {
  AppControlDriver,
  AppControlDriversResult,
  AppControlTarget,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { AppControlMenu, AppControlMenuItem, AppControlMenuLabel } from "./AppControlMenu";

export type AppControlStatusTone = "idle" | "active" | "warn" | "muted" | "error";

const STATUS_DOT_TONE: Record<AppControlStatusTone, string> = {
  idle: "bg-muted-fg/45",
  active: "bg-emerald-300",
  warn: "bg-amber-300",
  muted: "bg-muted-fg/40",
  error: "bg-rose-300",
};

const DRIVER_LABEL: Record<AppControlDriver, string> = {
  cdp: "CDP",
  computer_use: "Computer use",
};

/** Segments past this fold into the "Windows…" menu — a pane can be 280px. */
const MAX_WINDOW_SEGMENTS = 3;

export type AppControlLaunchRecent = { command: string; cwd: string | null };

function windowSegmentLabel(target: AppControlTarget): string {
  const title = (target.title ?? "").trim();
  if (title) return title;
  const url = (target.url ?? "").trim();
  if (url) return url.replace(/^https?:\/\//, "").replace(/^file:\/\//, "");
  return target.id.length > 6 ? `…${target.id.slice(-6)}` : target.id;
}

/**
 * The App Control top bar — the same 36px shell the browser toolbar uses.
 *
 * Reading left to right it answers the four questions this pane exists for:
 * which app am I driving, how am I driving it, is it actually attached, and
 * (when the runtime is somewhere else) whose machine is it running on.
 */
export function AppControlToolbar({
  appLabel,
  hasSession,
  recents,
  launchCommand,
  onLaunchCommandChange,
  onLaunch,
  canLaunch,
  launching,
  cdpPort,
  onCdpPortChange,
  onConnect,
  connecting,
  onHelpWireCdp,
  drivers,
  activeDriver,
  statusWord,
  statusTone,
  statusDetail,
  remoteLabel,
  windows,
  activeWindowId,
  onSwitchWindow,
  switching,
  controlsDisabled,
  pickerOpen,
  onPickerOpenChange,
  renderOverflow,
}: {
  appLabel: string;
  hasSession: boolean;
  recents: AppControlLaunchRecent[];
  launchCommand: string;
  onLaunchCommandChange: (value: string) => void;
  onLaunch: (command?: string, cwd?: string | null) => void;
  canLaunch: boolean;
  launching: boolean;
  cdpPort: string;
  onCdpPortChange: (value: string) => void;
  onConnect: () => void;
  connecting: boolean;
  onHelpWireCdp: (() => void) | null;
  drivers: AppControlDriversResult | null;
  activeDriver: AppControlDriver;
  statusWord: string;
  statusTone: AppControlStatusTone;
  statusDetail: string;
  remoteLabel: string | null;
  windows: AppControlTarget[];
  activeWindowId: string | null;
  onSwitchWindow: (targetId: string) => void;
  switching: boolean;
  controlsDisabled: boolean;
  /** Controlled so the empty state's "Pick an app to drive" can open it. */
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  renderOverflow: (close: () => void) => ReactNode;
}) {
  const segments = windows.slice(0, MAX_WINDOW_SEGMENTS);
  const overflowWindows = windows.slice(MAX_WINDOW_SEGMENTS);
  const driverRows = drivers?.drivers ?? [];

  return (
    <div className="flex min-h-[36px] shrink-0 items-center gap-1 border-b border-white/[0.08] px-1.5">
      {/* App picker — the launch target, and everything that changes it. */}
      <AppControlMenu
        ariaLabel="App Control launch target"
        triggerTitle={hasSession ? statusDetail : "Pick an app to drive"}
        triggerIcon={<AppWindow size={12} weight="duotone" className="shrink-0 text-muted-fg/75" />}
        triggerLabel={appLabel}
        triggerClassName="h-[24px] max-w-[46%]"
        menuClassName="w-[268px]"
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
      >
        {(close) => (
          <>
            <AppControlMenuLabel>Launch</AppControlMenuLabel>
            <div className="flex items-center gap-1 px-1 pb-1">
              <input
                value={launchCommand}
                onChange={(event) => onLaunchCommandChange(event.target.value)}
                placeholder='Launch command, e.g. "pnpm dev"'
                aria-label="App Control launch command"
                disabled={controlsDisabled}
                className={cn(
                  "h-[26px] min-w-0 flex-1 rounded-[var(--radius-sm)] border border-white/[0.08] bg-black/25 px-1.5",
                  "text-[10.5px] text-fg/85 outline-none placeholder:text-muted-fg/45",
                  "focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                )}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !canLaunch) return;
                  onLaunch();
                  close();
                }}
              />
              <button
                type="button"
                disabled={!canLaunch || launching}
                onClick={() => {
                  onLaunch();
                  close();
                }}
                title="Launch command in the terminal"
                aria-label="Launch App Control command"
                className={cn(
                  "inline-flex h-[26px] shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[10.5px] font-medium",
                  "border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
                  "bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-fg/90",
                  "transition-colors duration-[120ms] ease-out hover:bg-[color-mix(in_srgb,var(--color-accent)_24%,transparent)]",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                )}
              >
                {launching ? <SpinnerGap size={11} className="animate-spin" /> : <Play size={10} weight="fill" />}
                Run
              </button>
            </div>

            {recents.length > 0 ? (
              <>
                <AppControlMenuLabel>Recent</AppControlMenuLabel>
                {recents.map((recent) => (
                  <AppControlMenuItem
                    key={`${recent.command}::${recent.cwd ?? ""}`}
                    label={recent.command}
                    hint={recent.cwd ?? undefined}
                    disabled={controlsDisabled || hasSession}
                    disabledReason={hasSession ? "Stop the current session first." : undefined}
                    onSelect={() => {
                      onLaunch(recent.command, recent.cwd);
                      close();
                    }}
                  />
                ))}
              </>
            ) : null}

            <AppControlMenuLabel>Attach to running…</AppControlMenuLabel>
            <div className="flex items-center gap-1 px-1 pb-1">
              <input
                value={cdpPort}
                onChange={(event) => onCdpPortChange(event.target.value)}
                placeholder="CDP port"
                aria-label="CDP port"
                inputMode="numeric"
                disabled={controlsDisabled}
                className={cn(
                  "h-[26px] w-[86px] shrink-0 rounded-[var(--radius-sm)] border border-white/[0.08] bg-black/25 px-1.5",
                  "text-[10.5px] text-fg/85 outline-none placeholder:text-muted-fg/45",
                  "focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                )}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !cdpPort.trim()) return;
                  onConnect();
                  close();
                }}
              />
              <button
                type="button"
                disabled={!cdpPort.trim() || controlsDisabled || connecting}
                onClick={() => {
                  onConnect();
                  close();
                }}
                title="Connect to a running Electron app via CDP"
                className={cn(
                  "inline-flex h-[26px] shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[10.5px] font-medium",
                  "border border-white/[0.1] bg-white/[0.03] text-fg/80",
                  "transition-colors duration-[120ms] ease-out hover:bg-white/[0.07]",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                )}
              >
                {connecting ? <SpinnerGap size={11} className="animate-spin" /> : <LinkIcon size={10} />}
                Connect
              </button>
            </div>

            {onHelpWireCdp ? (
              <AppControlMenuItem
                icon={<Wrench size={11} />}
                label="Help wire CDP"
                hint="Insert a draft asking the agent to wire CDP debug flags into this app"
                onSelect={() => {
                  onHelpWireCdp();
                  close();
                }}
              />
            ) : null}
          </>
        )}
      </AppControlMenu>

      {/* Driver chip. Computer use is typed and capability-gated, not built. */}
      <AppControlMenu
        ariaLabel="App Control driver"
        triggerTitle={`Driving with ${DRIVER_LABEL[activeDriver]}`}
        triggerLabel={DRIVER_LABEL[activeDriver]}
        triggerClassName={cn(
          "h-[20px] rounded-full border border-white/[0.1] bg-white/[0.03] px-1.5",
          "text-[9.5px] uppercase tracking-[0.06em] text-muted-fg",
        )}
        showCaret={false}
        menuClassName="w-[236px]"
      >
        {(close) => (
          <>
            <AppControlMenuLabel>Driver</AppControlMenuLabel>
            {driverRows.length === 0 ? (
              <div className="px-2 pb-1.5 text-[10.5px] text-muted-fg/65">
                Driver support is still loading.
              </div>
            ) : (
              driverRows.map((row) => (
                <AppControlMenuItem
                  key={row.driver}
                  label={DRIVER_LABEL[row.driver]}
                  checked={row.driver === activeDriver}
                  disabled={row.status !== "available"}
                  disabledReason={row.reason}
                  onSelect={close}
                />
              ))
            )}
            {driverRows.some((row) => row.status !== "available" && row.reason) ? (
              <div className="px-2 pb-1.5 pt-0.5 text-[10px] leading-[14px] text-muted-fg/65">
                {driverRows.find((row) => row.status !== "available" && row.reason)?.reason}
              </div>
            ) : null}
          </>
        )}
      </AppControlMenu>

      {/* Status. One dot and one word — the detail lives in the tooltip. */}
      <span
        className="inline-flex min-w-0 shrink items-center gap-1.5 px-0.5 text-[10.5px] text-muted-fg"
        title={statusDetail}
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-[6px] w-[6px] shrink-0 rounded-full",
            STATUS_DOT_TONE[statusTone],
            statusTone === "warn" ? "motion-safe:animate-pulse" : null,
          )}
        />
        <span className="truncate">{statusWord}</span>
      </span>

      {remoteLabel ? (
        <span
          className={cn(
            "inline-flex h-[18px] shrink-0 items-center rounded-full border border-white/[0.1]",
            "bg-white/[0.03] px-1.5 text-[9.5px] text-muted-fg",
          )}
          title={`App Control runs on ${remoteLabel}`}
        >
          remote: {remoteLabel}
        </span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {windows.length > 1 ? (
          <div
            role="group"
            aria-label="Controlled window"
            className="inline-flex items-center rounded-[var(--radius-sm)] border border-white/[0.08] bg-white/[0.02] p-[1px]"
          >
            {segments.map((target) => {
              const label = windowSegmentLabel(target);
              const selected = (activeWindowId ?? "") === target.id;
              return (
                <button
                  key={target.id}
                  type="button"
                  disabled={controlsDisabled || switching}
                  aria-pressed={selected}
                  aria-label={`Switch to ${label}`}
                  title={label}
                  onClick={() => onSwitchWindow(target.id)}
                  className={cn(
                    "inline-flex h-[18px] max-w-[76px] items-center rounded-[3px] px-1.5 text-[10px]",
                    "transition-colors duration-[120ms] ease-out",
                    "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                    selected
                      ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg/90"
                      : "text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85",
                  )}
                >
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
            {overflowWindows.length > 0 ? (
              <AppControlMenu
                ariaLabel="More controlled windows"
                triggerLabel={`+${overflowWindows.length}`}
                showCaret={false}
                align="end"
                disabled={controlsDisabled || switching}
                triggerClassName="h-[18px] rounded-[3px] px-1.5 text-[10px] text-muted-fg/70"
                menuClassName="w-[236px]"
              >
                {(close) => (
                  <>
                    <AppControlMenuLabel>Windows</AppControlMenuLabel>
                    {overflowWindows.map((target) => (
                      <AppControlMenuItem
                        key={target.id}
                        label={windowSegmentLabel(target)}
                        checked={(activeWindowId ?? "") === target.id}
                        onSelect={() => {
                          onSwitchWindow(target.id);
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
              </AppControlMenu>
            ) : null}
          </div>
        ) : null}

        <AppControlMenu
          ariaLabel="App Control actions"
          triggerIcon={<DotsThree size={14} weight="bold" />}
          showCaret={false}
          align="end"
          triggerClassName="h-[24px] w-[24px] justify-center px-0"
          menuClassName="w-[232px]"
        >
          {renderOverflow}
        </AppControlMenu>
      </div>
    </div>
  );
}
