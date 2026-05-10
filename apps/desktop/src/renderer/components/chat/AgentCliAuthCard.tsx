import { useCallback, useState } from "react";
import { CopySimple, Play, Terminal, Warning } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export type AgentCliAuthCardInfo = {
  agent: string;
  displayName: string;
  category: "missing" | "unauthenticated";
  installCommand: string;
  authCommand: string;
};

function CommandCopyButton({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => setCopied(false));
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] text-fg/58 transition-colors hover:border-amber-300/25 hover:bg-amber-300/[0.07] hover:text-amber-100"
      title={copied ? "Copied" : `Copy ${label}`}
    >
      <CopySimple size={12} weight={copied ? "fill" : "regular"} aria-hidden />
      {copied ? "Copied" : label}
    </button>
  );
}

function ShellRunButton({
  command,
  label,
  laneId,
  chatSessionId,
  onRevealTerminal,
}: {
  command: string;
  label: string;
  laneId?: string | null;
  chatSessionId?: string | null;
  onRevealTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = running || !window.ade?.pty?.create || (!laneId && !window.ade?.lanes?.list);

  const handleRun = useCallback(() => {
    if (disabled) return;
    setRunning(true);
    setError(null);
    const terminalLabel = label.replace(/^Run\s+/i, "");
    void (async () => {
      const resolvedLaneId = laneId ?? (await window.ade.lanes.list({
        includeArchived: false,
        includeStatus: false,
      }))[0]?.id ?? null;
      if (!resolvedLaneId) {
        throw new Error("No active lane is available for this project.");
      }
      return window.ade.pty.create({
        laneId: resolvedLaneId,
        ...(chatSessionId ? { chatSessionId } : {}),
        cols: 100,
        rows: 28,
        title: terminalLabel,
        tracked: true,
        toolType: "shell",
        startupCommand: command,
      });
    })()
      .then((created) => {
        onRevealTerminal?.({
          terminalId: created.sessionId,
          ptyId: created.ptyId,
          label: terminalLabel,
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRunning(false));
  }, [chatSessionId, command, disabled, label, laneId, onRevealTerminal]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleRun}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/20 bg-amber-300/[0.08] px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] text-amber-100/82 transition-colors hover:border-amber-300/35 hover:bg-amber-300/[0.12] disabled:pointer-events-none disabled:opacity-45"
        title={!laneId && !window.ade?.lanes?.list ? "Open a project to run this command" : label}
      >
        <Play size={12} weight={running ? "fill" : "bold"} aria-hidden />
        {running ? "Opening" : label}
      </button>
      {error ? (
        <div className="max-w-[22rem] text-right font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-red-200/70">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function AgentCliAuthCard({
  agentCli,
  laneId,
  chatSessionId,
  runtimeName,
  onRevealTerminal,
}: {
  agentCli: AgentCliAuthCardInfo;
  laneId?: string | null;
  chatSessionId?: string | null;
  runtimeName?: string | null;
  onRevealTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
}) {
  const missing = agentCli.category === "missing";
  const installLocation = runtimeName?.trim() ? runtimeName.trim() : "this machine";
  const title = missing
    ? `${agentCli.displayName} is not installed`
    : `${agentCli.displayName} needs authentication`;
  const body = missing
    ? `Install the CLI on ${installLocation}, authenticate it, then retry the chat.`
    : `Authenticate the CLI on ${installLocation}, then retry the chat.`;

  return (
    <div className="mt-3 overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border border-amber-300/14 bg-amber-300/[0.045]">
      <div className="flex items-start gap-3 p-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-300/15 bg-amber-300/[0.08] text-amber-200">
          {missing ? <Terminal size={15} weight="bold" aria-hidden /> : <Warning size={15} weight="bold" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-amber-100/90">
            {title}
          </div>
          <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66">
            {body}
          </div>
          <div className="mt-3 grid gap-2">
            {missing ? (
              <div className="grid gap-1.5">
                <div className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-muted-fg/45">
                  Install
                </div>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/78">
                    {agentCli.installCommand}
                  </code>
                  <ShellRunButton
                    command={agentCli.installCommand}
                    label="Run install"
                    laneId={laneId}
                    chatSessionId={chatSessionId}
                    onRevealTerminal={onRevealTerminal}
                  />
                  <CommandCopyButton command={agentCli.installCommand} label="Copy install" />
                </div>
              </div>
            ) : null}
            <div className={cn("grid gap-1.5", missing ? "" : "mt-0")}>
              <div className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-muted-fg/45">
                Authenticate
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/78">
                  {agentCli.authCommand}
                </code>
                <ShellRunButton
                  command={agentCli.authCommand}
                  label="Run auth"
                  laneId={laneId}
                  chatSessionId={chatSessionId}
                  onRevealTerminal={onRevealTerminal}
                />
                <CommandCopyButton command={agentCli.authCommand} label="Copy auth" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
