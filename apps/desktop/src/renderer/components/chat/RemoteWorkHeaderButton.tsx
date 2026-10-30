import { useEffect, useMemo, useRef, useState } from "react";
import { AppleLogo, Desktop, LinuxLogo, Stop, WindowsLogo } from "@phosphor-icons/react";
import type { AgentChatRemoteWorkUse, AgentChatSessionSummary } from "../../../shared/types/chat";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ChatTerminalSession } from "../../../shared/types/sessions";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_MIN_WIDTH_CLASS, MENU_SCROLL_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { machinePlatform } from "../remoteTargets/MachineIdentity";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";

/**
 * The machines this chat is running commands on right now
 * (`ade shell start --machine`): those used since the current turn began.
 * Empty when the chat is idle, so the mark shows only while work is there.
 */
export function activeRemoteWork(session: Pick<AgentChatSessionSummary, "remoteWork" | "status" | "currentTurnStartedAt"> | null | undefined): AgentChatRemoteWorkUse[] {
  if (!session?.remoteWork?.length || session.status !== "active") return [];
  const turnStart = Date.parse(session.currentTurnStartedAt ?? "");
  return session.remoteWork.filter((use) =>
    !Number.isFinite(turnStart) || Date.parse(use.lastStartedAt) >= turnStart);
}

function PlatformGlyph({ platform, size }: { platform: string | null | undefined; size: number }) {
  switch (machinePlatform(platform)) {
    case "windows": return <WindowsLogo size={size} weight="bold" />;
    case "mac": return <AppleLogo size={size} weight="bold" />;
    case "linux": return <LinuxLogo size={size} weight="bold" />;
    default: return <Desktop size={size} weight="bold" />;
  }
}

/**
 * The pin that reaches `use`'s project on its machine: the desktop's paired
 * connection to it, or this computer's own checkout. Null when this window
 * has no connection to that machine; nothing is sent then.
 */
function useRemoteWorkPin(use: AgentChatRemoteWorkUse | null, active: boolean): OpenProjectBinding | null | "unreachable" {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const [localMachineKey, setLocalMachineKey] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.ade?.account?.getLocalMachineIdentity?.()
      .then((identity) => { if (!cancelled) setLocalMachineKey(identity?.machineKey?.trim() || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active]);
  return useMemo(() => {
    if (!use?.projectId || !use.projectRootPath) return "unreachable";
    if (localMachineKey && use.machineKey === localMachineKey) {
      return { kind: "local", key: use.projectRootPath, rootPath: use.projectRootPath, displayName: use.machineName };
    }
    const connection = snapshot?.connections.find((entry) =>
      entry.state === "connected" && entry.target.pairedMachine?.machineKey?.trim() === use.machineKey);
    if (!connection) return "unreachable";
    return {
      kind: "remote",
      key: remoteProjectBindingKey(connection.target.id, use.projectId),
      targetId: connection.target.id,
      runtimeName: connection.target.name,
      transport: connection.target.transport ?? "paired",
      hostname: connection.target.hostname,
      projectId: use.projectId,
      rootPath: use.projectRootPath,
      displayName: use.machineName,
    };
  }, [use, snapshot, localMachineKey]);
}

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
        <PlatformGlyph platform={uses[uses.length - 1]!.machinePlatform} size={16} />
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="bottom-end" remeasureKey={uses.length}>
        <div className={cn(MENU_SURFACE_CLASS, MENU_MIN_WIDTH_CLASS, MENU_SCROLL_CLASS, "max-w-[340px]")} role="menu">
          {uses.map((use) => <RemoteWorkMachine key={use.machineKey} use={use} active={open} />)}
        </div>
      </AnchoredMenu>
    </>
  );
}

function RemoteWorkMachine({ use, active }: { use: AgentChatRemoteWorkUse; active: boolean }) {
  const pin = useRemoteWorkPin(use, active);
  const pinKey = pin === "unreachable" ? null : pin?.key ?? null;
  const [shells, setShells] = useState<ChatTerminalSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminalKey = use.terminalIds.join(",");
  useEffect(() => {
    if (!active || pin === "unreachable" || !pin) return;
    let cancelled = false;
    void window.ade?.terminal?.list?.({ limit: 200 }, pin)
      .then((rows) => {
        if (cancelled) return;
        const wanted = new Set(use.terminalIds);
        setShells(rows.filter((row) => wanted.has(row.terminalId)));
      })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
    // Keyed on the pin's key and the terminal ids, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pinKey, terminalKey]);

  const stop = (terminalId: string) => {
    if (pin === "unreachable" || !pin) return;
    void window.ade?.terminal?.signal?.({ terminalId, signal: "SIGINT" }, pin)
      .then(() => setShells((rows) => rows?.map((row) => (row.terminalId === terminalId ? { ...row, status: "exited" as ChatTerminalSession["status"] } : row)) ?? rows))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const note = (text: string) => <div className="px-2 pb-1.5 text-muted-fg/70">{text}</div>;
  return (
    <div>
      <div className={cn(MENU_LABEL_CLASS, "flex items-center gap-1.5")}>
        <PlatformGlyph platform={use.machinePlatform} size={11} />
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
