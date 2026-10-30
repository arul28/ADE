import { useEffect, useMemo, useRef, useState } from "react";
import { Stop } from "@phosphor-icons/react";
import type { AgentChatRemoteWorkUse, AgentChatSessionSummary } from "../../../shared/types/chat";
import type { ChatTerminalSession } from "../../../shared/types/sessions";
import { activeRemoteWork, remoteWorkUseKey } from "../../../shared/chatRemoteWork";
import { listRemoteWorkShells, useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";
import { showToast } from "../app/toast/toastStore";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_MIN_WIDTH_CLASS, MENU_SCROLL_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";

/*
 * Where a chat's work on another machine shows (`ade shell start --machine`,
 * `ade apple … --machine`): the chat header's mark with its commands, and the
 * session card's mark.
 */

/**
 * One mark in the chat header while the chat runs commands on another
 * machine: that machine's logo. A click lists those commands, each with Stop.
 */
export function RemoteWorkHeaderButton({ session }: { session: AgentChatSessionSummary | null | undefined }) {
  const uses = activeRemoteWork(session);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (!uses.length) return null;
  const label = `Working on ${uses.map((use) => use.machineName).join(" and ")}`;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="remote-work-presence"
        className={WORK_HEADER_ICON_BUTTON_CLASS}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MachinePlatformLogo platform={uses[uses.length - 1]!.machinePlatform} size={16} weight="bold" fallback />
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="bottom-end" remeasureKey={uses.length}>
        <div className={cn(MENU_SURFACE_CLASS, MENU_MIN_WIDTH_CLASS, MENU_SCROLL_CLASS, "max-w-[340px]")} role="menu">
          {uses.map((use) => <RemoteWorkMachine key={remoteWorkUseKey(use)} use={use} active={open} />)}
        </div>
      </AnchoredMenu>
    </>
  );
}

function RemoteWorkMachine({ use, active }: { use: AgentChatRemoteWorkUse; active: boolean }) {
  const resolvePin = useRemoteWorkPinResolver(active);
  const pin = useMemo(() => resolvePin(use), [resolvePin, use]);
  const pinKey = pin === "unreachable" ? null : pin.key;
  const [shells, setShells] = useState<ChatTerminalSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminalKey = use.terminalIds.join(",");
  const [readNonce, setReadNonce] = useState(0);
  useEffect(() => {
    if (!active || pin === "unreachable") return;
    let cancelled = false;
    void listRemoteWorkShells(use, pin)
      .then((rows) => {
        if (cancelled) return;
        setShells(rows);
        setError(null);
      })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
    // Keyed on the pin's key and the terminal ids, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pinKey, terminalKey, readNonce]);

  const stop = (terminalId: string) => {
    if (pin === "unreachable") return;
    void window.ade.terminal.signal({ terminalId, signal: "SIGINT" }, pin)
      // Read the list again rather than assume it stopped: a command may handle SIGINT.
      .then(() => setReadNonce((value) => value + 1))
      .catch((reason: unknown) => showToast({
        tone: "error",
        title: `Couldn't stop the command on ${use.machineName}`,
        message: reason instanceof Error ? reason.message : String(reason),
      }));
  };

  const note = (text: string) => <div className="px-2 pb-1.5 text-muted-fg/70">{text}</div>;
  return (
    <div>
      <div className={cn(MENU_LABEL_CLASS, "flex items-center gap-1.5")}>
        <MachinePlatformLogo platform={use.machinePlatform} size={11} weight="bold" fallback />
        <span>{use.machineName}</span>
      </div>
      {pin === "unreachable" ? note(`This window is not connected to ${use.machineName}.`)
        : error ? note(error)
        : shells === null ? note("Loading…")
        : shells.length === 0 ? note("No commands there now.")
        : shells.map((shell) => (
          <div key={shell.terminalId} className={cn(MENU_ITEM_CLASS, "cursor-default")}>
            <span className="min-w-0 flex-1 truncate font-mono" title={shell.title}>{shell.title}</span>
            {shell.status === "running" ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-fg/[0.08]" onClick={() => stop(shell.terminalId)}>
                <Stop size={10} weight="fill" /> Stop
              </button>
            ) : (
              <span className="shrink-0 text-muted-fg/70">{shell.exitCode == null ? "ended" : `exit ${shell.exitCode}`}</span>
            )}
          </div>
        ))}
    </div>
  );
}

/** The same mark on a session card: the machine logo, while the turn works there. */
export function RemoteWorkBadge({ uses, size = 11 }: { uses: AgentChatRemoteWorkUse[] | null | undefined; size?: number }) {
  if (!uses?.length) return null;
  const label = `Working on ${uses.map((use) => use.machineName).join(" and ")}`;
  return (
    <span data-testid="remote-work-badge" role="img" title={label} aria-label={label} className="inline-flex shrink-0 items-center justify-center text-muted-fg/80">
      <MachinePlatformLogo platform={uses[uses.length - 1]!.machinePlatform} size={size} weight="bold" fallback />
    </span>
  );
}
