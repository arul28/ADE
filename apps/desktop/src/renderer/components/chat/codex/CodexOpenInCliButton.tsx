import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Terminal } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";

type CodexOpenInCliButtonProps = {
  sessionId: string;
  /**
   * Called when the user picks "In ADE terminal". The button does the IPC call to
   * resolve the resume command; the parent is responsible for revealing the
   * built-in terminal drawer and feeding the command into it. The path is the
   * chat lane's worktree.
   */
  onUseAdeTerminal: (args: {
    binary: string;
    argv: string[];
    cwd: string;
    threadId: string;
    copyThreadIdToClipboard: boolean;
  }) => void;
};

export function CodexOpenInCliButton({ sessionId, onUseAdeTerminal }: CodexOpenInCliButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleNewWindow = useCallback(async () => {
    setOpen(false);
    setError(null);
    setBusy(true);
    try {
      const result = await window.ade.agentChat.codex.openInCli({
        sessionId,
        mode: "new-window",
      });
      if (result.copyThreadIdToClipboard) {
        await navigator.clipboard.writeText(result.threadId).catch(() => undefined);
        setToast("Thread ID copied — paste into Codex's Ctrl+R picker");
      } else {
        setToast("Opened in a new terminal");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const handleAdeTerminal = useCallback(async () => {
    setOpen(false);
    setError(null);
    setBusy(true);
    try {
      const result = await window.ade.agentChat.codex.openInCli({
        sessionId,
        mode: "ade-terminal",
      });
      if (result.copyThreadIdToClipboard) {
        await navigator.clipboard.writeText(result.threadId).catch(() => undefined);
        setToast("Thread ID copied — paste into Codex's Ctrl+R picker");
      }
      onUseAdeTerminal({
        binary: result.binary,
        argv: result.argv,
        cwd: result.cwd,
        threadId: result.threadId,
        copyThreadIdToClipboard: result.copyThreadIdToClipboard,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, onUseAdeTerminal]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-sans text-[10px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50",
          open
            ? "border-violet-400/20 bg-violet-500/[0.08] text-violet-200/80"
            : "border-white/[0.08] bg-white/[0.03] text-fg/45 hover:border-white/[0.12] hover:text-fg/65",
        )}
        title="Open this Codex thread in the Codex CLI"
      >
        <Terminal size={12} weight={open ? "fill" : "regular"} />
        <span>Open in Codex CLI</span>
        <ArrowSquareOut size={9} weight="bold" className="opacity-60" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[220px] overflow-hidden rounded-md border border-fg/12 bg-bg/95 shadow-lg backdrop-blur"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleAdeTerminal}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[length:calc(var(--chat-font-size)*11/14)] text-fg/85 hover:bg-fg/[0.06]"
          >
            <Terminal size={12} weight="bold" className="shrink-0 text-fg/55" />
            <span>In ADE terminal</span>
          </button>
          <div className="h-px bg-fg/8" />
          <button
            type="button"
            role="menuitem"
            onClick={handleNewWindow}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[length:calc(var(--chat-font-size)*11/14)] text-fg/85 hover:bg-fg/[0.06]"
          >
            <ArrowSquareOut size={12} weight="bold" className="shrink-0 text-fg/55" />
            <span>In new window</span>
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none absolute right-0 top-[calc(100%+4px)] z-30 rounded-md border border-emerald-400/25 bg-emerald-500/12 px-2.5 py-1 text-[length:calc(var(--chat-font-size)*10/14)] text-emerald-100 shadow-lg">
          {toast}
        </div>
      ) : null}
      {error ? (
        <div className="pointer-events-none absolute right-0 top-[calc(100%+4px)] z-30 rounded-md border border-red-400/30 bg-red-500/12 px-2.5 py-1 text-[length:calc(var(--chat-font-size)*10/14)] text-red-100 shadow-lg">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export default CodexOpenInCliButton;
