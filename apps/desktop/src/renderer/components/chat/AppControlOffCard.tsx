import { Desktop, Link as LinkIcon, Play, SpinnerGap, Wrench } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { WORK_TOOL_PRIMARY_BUTTON, WORK_TOOL_SECTION_LABEL_TEXT } from "../terminals/workToolChrome";
import { MAC_DESKTOP_SECONDARY_BUTTON, MacDesktopStateCard } from "./MacDesktopStateCard";
import type { AppControlLaunchRecent } from "./AppControlToolbar";

const FIELD = cn(
  "h-8 min-w-0 rounded-[8px] border border-border/70 bg-[color-mix(in_srgb,var(--color-bg)_55%,transparent)] px-2.5",
  "font-sans text-[12px] text-fg outline-none placeholder:text-muted-fg/60",
  "transition-colors duration-[120ms] ease-out",
  "focus:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]",
  "disabled:cursor-not-allowed disabled:opacity-45",
);

/**
 * App Control with no app: the same card the Mac Desktop pane shows when it
 * is off, with the two ways in on its face.
 *
 * Launch runs a command in a terminal in this lane and attaches over CDP.
 * Attach connects to an Electron app that is already running with a debug
 * port. Both used to live only in the toolbar's app picker, behind a button on
 * an otherwise empty pane.
 */
export function AppControlOffCard({
  launchCommand,
  onLaunchCommandChange,
  launchCwd,
  onLaunchCwdChange,
  onLaunch,
  canLaunch,
  launching,
  cdpPort,
  onCdpPortChange,
  onConnect,
  connecting,
  recents,
  onHelpWireCdp,
  controlsDisabled,
  laneName,
}: {
  launchCommand: string;
  onLaunchCommandChange: (value: string) => void;
  launchCwd: string;
  onLaunchCwdChange: (value: string) => void;
  onLaunch: (command?: string, cwd?: string | null) => void;
  canLaunch: boolean;
  launching: boolean;
  cdpPort: string;
  onCdpPortChange: (value: string) => void;
  onConnect: () => void;
  connecting: boolean;
  recents: AppControlLaunchRecent[];
  onHelpWireCdp: (() => void) | null;
  controlsDisabled: boolean;
  laneName?: string | null;
}) {
  const busy = launching || connecting;
  return (
    <MacDesktopStateCard
      testId="app-control-off"
      tone="idle"
      icon={Desktop}
      title="No app attached"
      detail={laneName
        ? `Launch ${laneName}'s Electron app, or attach to one that is already running.`
        : "Launch this lane's Electron app, or attach to one that is already running."}
    >
      <form
        className="flex w-full min-w-0 flex-col gap-2 text-left"
        aria-label="Launch an app"
        onSubmit={(event) => {
          event.preventDefault();
          if (canLaunch && !busy) onLaunch();
        }}
      >
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Launch</span>
        <input
          value={launchCommand}
          onChange={(event) => onLaunchCommandChange(event.target.value)}
          placeholder="pnpm dev"
          aria-label="App Control launch command"
          disabled={controlsDisabled}
          spellCheck={false}
          className={cn(FIELD, "w-full font-mono text-[11.5px]")}
        />
        <div className="flex min-w-0 items-center gap-2">
          <input
            value={launchCwd}
            onChange={(event) => onLaunchCwdChange(event.target.value)}
            placeholder="Folder (optional, lane root)"
            aria-label="App Control launch folder"
            disabled={controlsDisabled}
            spellCheck={false}
            className={cn(FIELD, "flex-1 font-mono text-[11.5px]")}
          />
          <button
            type="submit"
            disabled={!canLaunch || busy}
            aria-label="Launch App Control command"
            className={WORK_TOOL_PRIMARY_BUTTON}
            data-testid="app-control-launch"
          >
            {launching ? <SpinnerGap size={14} className="animate-spin" /> : <Play size={14} weight="fill" />}
            Launch
          </button>
        </div>
      </form>

      {recents.length > 0 ? (
        <div className="flex w-full min-w-0 flex-col gap-1 text-left" data-testid="app-control-recents">
          <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Recent</span>
          <ul className="flex min-w-0 flex-col">
            {recents.map((recent) => (
              <li key={`${recent.command}::${recent.cwd ?? ""}`}>
                <button
                  type="button"
                  disabled={controlsDisabled || busy}
                  onClick={() => onLaunch(recent.command, recent.cwd)}
                  title={recent.cwd ? `${recent.command} in ${recent.cwd}` : recent.command}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-left",
                    "font-mono text-[11.5px] text-fg/85 transition-colors duration-[120ms] ease-out",
                    "hover:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-45",
                  )}
                >
                  <Play size={11} className="shrink-0 text-muted-fg" />
                  <span className="min-w-0 flex-1 truncate">{recent.command}</span>
                  {recent.cwd ? (
                    <span className="max-w-[40%] shrink truncate font-sans text-[11px] text-muted-fg">{recent.cwd}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        className="flex w-full min-w-0 flex-col gap-2 border-t border-border/60 pt-3 text-left"
        aria-label="Attach to a running app"
        onSubmit={(event) => {
          event.preventDefault();
          if (cdpPort.trim() && !busy && !controlsDisabled) onConnect();
        }}
      >
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Attach to a running app</span>
        <div className="flex min-w-0 items-center gap-2">
          <input
            value={cdpPort}
            onChange={(event) => onCdpPortChange(event.target.value)}
            placeholder="CDP port, e.g. 9222"
            aria-label="CDP port"
            inputMode="numeric"
            disabled={controlsDisabled}
            className={cn(FIELD, "flex-1 tabular-nums")}
          />
          <button
            type="submit"
            disabled={!cdpPort.trim() || controlsDisabled || busy}
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            data-testid="app-control-attach"
          >
            {connecting ? <SpinnerGap size={14} className="animate-spin" /> : <LinkIcon size={14} />}
            Attach
          </button>
        </div>
      </form>

      {onHelpWireCdp ? (
        <button
          type="button"
          onClick={onHelpWireCdp}
          className="inline-flex items-center gap-1.5 self-start font-sans text-[12px] text-muted-fg underline-offset-2 transition-colors hover:text-fg hover:underline"
        >
          <Wrench size={12} />
          Help wire CDP
        </button>
      ) : null}
    </MacDesktopStateCard>
  );
}
