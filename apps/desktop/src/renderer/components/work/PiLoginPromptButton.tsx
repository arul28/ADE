import { useState } from "react";
import { SpinnerGap, Terminal } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

export type PiLoginTerminal = {
  terminalId: string;
  ptyId: string;
  laneId: string;
  label: string;
};

type WorkNavigate = (path: string) => void;

async function resolvePiLoginLaneId(laneId?: string | null): Promise<string> {
  if (laneId) return laneId;
  const lanes = await window.ade.lanes.list({ includeArchived: false, includeStatus: false });
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0];
  if (!primary?.id) throw new Error("No active lane is available for this project.");
  return primary.id;
}

export async function createPiLoginTerminal({
  laneId,
  chatSessionId,
}: {
  laneId?: string | null;
  chatSessionId?: string | null;
} = {}): Promise<PiLoginTerminal> {
  if (!window.ade?.pty?.create) throw new Error("Terminal sessions are not available in this ADE runtime.");
  const resolvedLaneId = await resolvePiLoginLaneId(laneId);
  const created = await window.ade.pty.create({
    laneId: resolvedLaneId,
    ...(chatSessionId ? { chatSessionId } : {}),
    cols: 100,
    rows: 28,
    title: "Pi login",
    tracked: true,
    toolType: "shell",
    startupCommand: "pi",
    // Pi's OAuth/device-code flow is entered from its interactive command
    // palette. Sending this after startup preserves Pi's native auth UX.
    initialInput: "/login\n",
    initialInputDelayMs: 1_200,
  });
  return {
    laneId: resolvedLaneId,
    terminalId: created.sessionId,
    ptyId: created.ptyId,
    label: "Pi login",
  };
}

export function revealPiTerminalInWork(
  navigate: WorkNavigate,
  terminal: { terminalId: string; laneId: string },
  delayMs = 80,
): void {
  navigate("/work");
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("ade:work:select-session", {
      detail: { sessionId: terminal.terminalId, laneId: terminal.laneId },
    }));
  }, delayMs);
}

export async function createPiLoginTerminalInWork({
  navigate,
  laneId,
  chatSessionId,
}: {
  navigate: WorkNavigate;
  laneId?: string | null;
  chatSessionId?: string | null;
}): Promise<PiLoginTerminal> {
  const terminal = await createPiLoginTerminal({ laneId, chatSessionId });
  revealPiTerminalInWork(navigate, terminal);
  return terminal;
}

export function PiLoginPromptButton({
  visible,
  laneId,
  chatSessionId,
  onRevealTerminal,
  className,
}: {
  visible: boolean;
  laneId?: string | null;
  chatSessionId?: string | null;
  onRevealTerminal?: (terminal: PiLoginTerminal) => void;
  className?: string;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  if (!visible) return null;

  const open = () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    void createPiLoginTerminal({ laneId, chatSessionId })
      .then((terminal) => onRevealTerminal?.(terminal))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setOpening(false));
  };

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <button
        type="button"
        onClick={open}
        disabled={opening || !window.ade?.pty?.create}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-orange-300/25 bg-orange-300/[0.08] px-2 font-mono text-[10px] font-semibold text-orange-100/85 transition-colors hover:border-orange-300/40 hover:bg-orange-300/[0.13] disabled:cursor-not-allowed disabled:opacity-50"
        title="Open Pi and run /login"
        aria-busy={opening}
      >
        {opening ? <SpinnerGap size={12} className={reducedMotion ? undefined : "animate-spin"} aria-hidden /> : <Terminal size={12} weight="bold" aria-hidden />}
        {opening ? "Opening Pi…" : "Open Pi /login"}
      </button>
      {opening ? <span role="status" aria-live="polite" className="max-w-[24rem] text-[10px] text-muted-fg/70">Opening Pi’s native login terminal…</span> : null}
      {error ? <span role="alert" aria-live="assertive" className="max-w-[24rem] text-[10px] text-red-200/75">{error}</span> : null}
    </span>
  );
}
