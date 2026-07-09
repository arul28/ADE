import { useCallback, useEffect, useState } from "react";
import { SpinnerGap, Terminal, X } from "@phosphor-icons/react";
import { CLAUDE_AUTH_LOGIN_COMMAND } from "../../lib/claudeAuthPrompt";
import { cn } from "../ui/cn";

type RevealTerminalRequest = {
  terminalId: string;
  ptyId: string;
  label: string;
};

type ClaudeLoginTerminalCreated = RevealTerminalRequest & {
  laneId: string;
};

async function resolveClaudeLoginLaneId(laneId?: string | null): Promise<string> {
  if (laneId) return laneId;
  const listLanes = window.ade?.lanes?.list;
  const availableLanes = typeof listLanes === "function" ? await listLanes({
    includeArchived: false,
    includeStatus: false,
  }) : [];
  const primaryLane = availableLanes.find((lane) => lane.laneType === "primary") ?? null;
  const resolvedLaneId = primaryLane?.id ?? availableLanes[0]?.id ?? null;
  if (!resolvedLaneId) {
    throw new Error("No active lane is available for this project.");
  }
  return resolvedLaneId;
}

export async function createClaudeLoginTerminal({
  laneId,
  chatSessionId,
}: {
  laneId?: string | null;
  chatSessionId?: string | null;
} = {}): Promise<ClaudeLoginTerminalCreated> {
  if (!window.ade?.pty?.create) {
    throw new Error("Terminal sessions are not available in this ADE runtime.");
  }
  const resolvedLaneId = await resolveClaudeLoginLaneId(laneId);
  const created = await window.ade.pty.create({
    laneId: resolvedLaneId,
    ...(chatSessionId ? { chatSessionId } : {}),
    cols: 100,
    rows: 28,
    title: "Claude login",
    tracked: true,
    toolType: "shell",
    startupCommand: CLAUDE_AUTH_LOGIN_COMMAND,
  });
  return {
    laneId: resolvedLaneId,
    terminalId: created.sessionId,
    ptyId: created.ptyId,
    label: "Claude login",
  };
}

function dismissedKey(storageKey: string): string {
  return `ade.claudeLoginPrompt.dismissed.v1:${storageKey}`;
}

function readDismissed(storageKey: string): boolean {
  try {
    return window.sessionStorage.getItem(dismissedKey(storageKey)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(storageKey: string): void {
  try {
    window.sessionStorage.setItem(dismissedKey(storageKey), "1");
  } catch {
    // Best-effort per-window dismissal.
  }
}

function clearDismissed(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(dismissedKey(storageKey));
  } catch {
    // Best-effort per-window dismissal reset.
  }
}

export function ClaudeLoginPromptButton({
  visible,
  storageKey,
  laneId,
  chatSessionId,
  onRevealTerminal,
  onTerminalCreated,
  dismissible = true,
  className,
}: {
  visible: boolean;
  storageKey: string;
  laneId?: string | null;
  chatSessionId?: string | null;
  onRevealTerminal?: (terminal: RevealTerminalRequest) => void;
  onTerminalCreated?: (terminal: ClaudeLoginTerminalCreated) => void;
  dismissible?: boolean;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(() => readDismissed(storageKey));
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed(storageKey));
    setError(null);
  }, [storageKey]);

  useEffect(() => {
    if (visible) return;
    clearDismissed(storageKey);
    setDismissed(false);
    setError(null);
  }, [storageKey, visible]);

  const dismiss = useCallback(() => {
    writeDismissed(storageKey);
    setDismissed(true);
  }, [storageKey]);

  const handleLogin = useCallback(() => {
    if (opening || !window.ade?.pty?.create) return;
    setOpening(true);
    setError(null);
    void (async () => {
      const reveal = await createClaudeLoginTerminal({ laneId, chatSessionId });
      onRevealTerminal?.(reveal);
      onTerminalCreated?.(reveal);
      if (!chatSessionId) {
        window.dispatchEvent(new CustomEvent("ade:work:select-session", {
          detail: { sessionId: reveal.terminalId, laneId: reveal.laneId },
        }));
      }
    })()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setOpening(false));
  }, [chatSessionId, laneId, onRevealTerminal, onTerminalCreated, opening]);

  if (!visible || (dismissible && dismissed)) return null;

  return (
    <div className={cn("relative inline-flex shrink-0 items-center", className)}>
      <div className="inline-flex h-6 overflow-hidden rounded-md border border-[#d97757]/35 bg-[#d97757]/15 shadow-[0_0_18px_rgba(217,119,87,0.12)]">
        <button
          type="button"
          onClick={handleLogin}
          disabled={opening || !window.ade?.pty?.create}
          className="inline-flex h-full items-center gap-1.5 px-2 font-sans text-[10px] font-semibold text-[#ffd7c2] transition-colors hover:bg-[#d97757]/18 disabled:cursor-not-allowed disabled:opacity-55"
          title={error ?? "Open a terminal here and run claude auth login"}
          aria-label="Login to Claude"
        >
          {opening ? <SpinnerGap size={12} className="animate-spin" aria-hidden /> : <Terminal size={12} weight="bold" aria-hidden />}
          <span className="whitespace-nowrap">Login to Claude</span>
        </button>
        {dismissible ? (
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex h-full w-5 items-center justify-center border-l border-[#d97757]/25 text-[#ffd7c2]/65 transition-colors hover:bg-[#d97757]/18 hover:text-[#ffe4d5]"
            aria-label="Dismiss Claude login prompt"
            title="Dismiss"
          >
            <X size={10} weight="bold" aria-hidden />
          </button>
        ) : null}
      </div>
      {error ? (
        <span className="absolute right-0 top-[calc(100%+4px)] z-20 max-w-[16rem] rounded-md border border-red-400/20 bg-red-950/90 px-2 py-1 text-right text-[10px] text-red-100 shadow-lg">
          {error}
        </span>
      ) : null}
    </div>
  );
}
