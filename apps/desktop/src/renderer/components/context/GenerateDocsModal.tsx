import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button";
import { TerminalView } from "../terminals/TerminalView";
import { useAppStore } from "../../state/appStore";
import type {
  AgentTool,
  ContextDocProvider,
  ContextPrepareDocGenResult,
  LaneSummary
} from "../../../shared/types";

type Phase = "configure" | "running" | "done";
type DoneStatus = "completed" | "failed" | "cancelled";

// --- Claude options ---
type ClaudePermissionMode = "bypass" | "acceptEdits" | "manual";
type ClaudeMultiAgent = "teams" | "parallel" | "none";

// --- Codex options ---
type CodexApprovalMode = "fullAuto" | "autoEdit" | "suggest" | "manual";

function buildCommand(
  provider: ContextDocProvider,
  opts: {
    promptFilePath: string;
    claudePermission: ClaudePermissionMode;
    claudeMultiAgent: ClaudeMultiAgent;
    codexApproval: CodexApprovalMode;
  }
): string {
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const promptArg = `"$(cat ${q(opts.promptFilePath)})"`;

  if (provider === "claude") {
    const parts: string[] = [];

    // Env var prefix for agent teams
    if (opts.claudeMultiAgent === "teams") {
      parts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
    }

    parts.push("claude");

    // Permission flags
    if (opts.claudePermission === "bypass") {
      parts.push("--dangerously-skip-permissions");
    } else if (opts.claudePermission === "acceptEdits") {
      parts.push("--permission-mode", "acceptEdits");
    }

    parts.push(promptArg);
    return parts.join(" ");
  }

  // Codex
  const parts: string[] = ["codex"];
  if (opts.codexApproval === "fullAuto") {
    parts.push("--full-auto");
  } else if (opts.codexApproval === "autoEdit") {
    parts.push("--ask-for-approval", "on-failure", "--sandbox", "workspace-write");
  } else if (opts.codexApproval === "suggest") {
    parts.push("--ask-for-approval", "untrusted", "--sandbox", "workspace-write");
  }
  // manual → no flags (default interactive)

  parts.push(promptArg);
  return parts.join(" ");
}

function buildPromptSuffix(
  provider: ContextDocProvider,
  claudeMultiAgent: ClaudeMultiAgent
): string {
  if (provider !== "claude") return "";
  if (claudeMultiAgent === "teams") {
    return `
## Multi-Agent Strategy

You have agent teams enabled. Use your team coordination capabilities to
parallelize the exploration. For example, have one agent explore the source
code structure while another reads documentation and a third examines config
and build files. Synthesize all findings into the two output documents.
`;
  }
  if (claudeMultiAgent === "parallel") {
    return `
## Multi-Agent Strategy

Use the Task tool to spawn parallel subagents for faster exploration.
For example, launch one subagent to explore source code structure, another
to read existing documentation, and another to examine configuration and
build files. Collect their results and synthesize into the two output documents.
`;
  }
  return "";
}

// --- Spinner SVG ---
function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className ?? "h-4 w-4"}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-4 w-4"} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function GenerateDocsModal({
  open,
  onOpenChange,
  onCompleted
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const lanes = useAppStore((s) => s.lanes);

  // --- Configure state ---
  const [phase, setPhase] = React.useState<Phase>("configure");
  const [tools, setTools] = React.useState<AgentTool[]>([]);
  const [detecting, setDetecting] = React.useState(false);
  const [provider, setProvider] = React.useState<ContextDocProvider>("claude");
  const [selectedLaneId, setSelectedLaneId] = React.useState<string>("");

  // Claude options
  const [claudePermission, setClaudePermission] = React.useState<ClaudePermissionMode>("bypass");
  const [claudeMultiAgent, setClaudeMultiAgent] = React.useState<ClaudeMultiAgent>("none");

  // Codex options
  const [codexApproval, setCodexApproval] = React.useState<CodexApprovalMode>("fullAuto");

  // --- Running state ---
  const [ptyId, setPtyId] = React.useState<string | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [prepResult, setPrepResult] = React.useState<ContextPrepareDocGenResult | null>(null);
  const [prdExists, setPrdExists] = React.useState(false);
  const [archExists, setArchExists] = React.useState(false);
  const [processExited, setProcessExited] = React.useState(false);

  // --- Done state ---
  const [doneStatus, setDoneStatus] = React.useState<DoneStatus | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);
  const [installError, setInstallError] = React.useState<string | null>(null);

  const ptyIdRef = React.useRef<string | null>(null);
  const processExitedRef = React.useRef(false);

  const docsReady = prdExists && archExists;

  // --- Pick default lane when modal opens ---
  React.useEffect(() => {
    if (!open) return;
    const primary = lanes.find((l: LaneSummary) => l.laneType === "primary");
    setSelectedLaneId(primary?.id ?? lanes[0]?.id ?? "");
  }, [open, lanes]);

  // --- Detect tools on open ---
  React.useEffect(() => {
    if (!open) return;
    setDetecting(true);
    window.ade.agentTools
      .detect()
      .then((detected) => {
        setTools(detected);
        const installed = detected.filter((t) => t.installed && (t.id === "claude" || t.id === "codex"));
        if (installed.length && !installed.find((t) => t.id === provider)) {
          setProvider(installed[0]!.id as ContextDocProvider);
        }
      })
      .catch(() => {})
      .finally(() => setDetecting(false));
  }, [open]);

  // --- Poll doc existence during running phase ---
  React.useEffect(() => {
    if (phase !== "running") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await window.ade.context.getStatus();
        if (cancelled) return;
        const prd = status.docs.find((d) => d.id === "prd_ade");
        const arch = status.docs.find((d) => d.id === "architecture_ade");
        setPrdExists(prd?.exists ?? false);
        setArchExists(arch?.exists ?? false);
      } catch {
        // ignore
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase]);

  // --- Listen for PTY exit ---
  React.useEffect(() => {
    if (!ptyId) return;
    const unsub = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      const code = ev.exitCode ?? -1;
      setExitCode(code);
      setProcessExited(true);
      processExitedRef.current = true;

      if (code === 0) {
        setDoneStatus("completed");
        if (prepResult) {
          window.ade.context
            .installGeneratedDocs({
              provider: prepResult.provider,
              outputPrdPath: prepResult.outputPrdPath,
              outputArchPath: prepResult.outputArchPath
            })
            .then(() => onCompleted())
            .catch((err) => setInstallError(err instanceof Error ? err.message : String(err)));
        }
      } else {
        setDoneStatus("failed");
      }
      setPhase("done");
    });
    return unsub;
  }, [ptyId, prepResult, onCompleted]);

  // --- Reset state when modal closes ---
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setPhase("configure");
      setPtyId(null);
      setSessionId(null);
      setPrepResult(null);
      setDoneStatus(null);
      setExitCode(null);
      setInstallError(null);
      setPrdExists(false);
      setArchExists(false);
      setProcessExited(false);
      processExitedRef.current = false;
      ptyIdRef.current = null;
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  const installedTools = tools.filter((t) => t.installed && (t.id === "claude" || t.id === "codex"));
  const noToolsInstalled = !detecting && installedTools.length === 0;

  // --- Run handler ---
  const handleRun = async () => {
    try {
      const prep = await window.ade.context.prepareDocGeneration({
        provider,
        laneId: selectedLaneId
      });
      setPrepResult(prep);

      const pty = await window.ade.pty.create({
        laneId: selectedLaneId,
        cwd: prep.cwd,
        cols: 100,
        rows: 30,
        title: `Generate Docs (${provider})`,
        tracked: false
      });
      setPtyId(pty.ptyId);
      setSessionId(pty.sessionId);
      ptyIdRef.current = pty.ptyId;
      setPhase("running");

      // Build the prompt suffix for multi-agent modes
      const suffix = buildPromptSuffix(provider, claudeMultiAgent);
      if (suffix) {
        // Append to prompt file via shell
        const appendCmd = `printf '%s' ${shellQuote(suffix)} >> ${shellQuote(prep.promptFilePath)}`;
        await window.ade.pty.write({ ptyId: pty.ptyId, data: appendCmd + "\r" });
        // Small delay so the file write completes before launching
        await new Promise((r) => setTimeout(r, 300));
      }

      const cmd = buildCommand(provider, {
        promptFilePath: prep.promptFilePath,
        claudePermission,
        claudeMultiAgent,
        codexApproval
      });
      await window.ade.pty.write({ ptyId: pty.ptyId, data: cmd + "\r" });
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setDoneStatus("failed");
      setPhase("done");
    }
  };

  // --- Cancel / dispose PTY ---
  const disposePty = async () => {
    if (ptyIdRef.current) {
      try {
        await window.ade.pty.dispose({ ptyId: ptyIdRef.current });
      } catch { /* ignore */ }
    }
  };

  const handleCancel = async () => {
    await disposePty();
    setDoneStatus("cancelled");
    setPhase("done");
  };

  // --- Close handler with warning ---
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // If still running, warn and kill
      if (phase === "running") {
        const shouldClose = window.confirm(
          "Generation is still running. Closing will kill the process. Continue?"
        );
        if (!shouldClose) return;
        void disposePty().then(() => onOpenChange(false));
        return;
      }
      // If done but docs not ready, warn
      if (phase === "done" && !docsReady && doneStatus !== "cancelled") {
        const shouldClose = window.confirm(
          "The generated docs may not have been created successfully. Close anyway?"
        );
        if (!shouldClose) return;
      }
      // Always dispose PTY on close to avoid orphans
      void disposePty();
    }
    onOpenChange(next);
  };

  // --- Render helpers ---
  const statusBadge = () => {
    if (!doneStatus) return null;
    const colors: Record<DoneStatus, string> = {
      completed: "bg-green-500/10 text-green-700 border-green-500/30",
      failed: "bg-red-500/10 text-red-700 border-red-500/30",
      cancelled: "bg-neutral-500/10 text-neutral-600 border-neutral-500/30"
    };
    const labels: Record<DoneStatus, string> = {
      completed: "Completed",
      failed: `Failed (exit ${exitCode ?? "?"})`,
      cancelled: "Cancelled"
    };
    return (
      <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${colors[doneStatus]}`}>
        {labels[doneStatus]}
      </span>
    );
  };

  const docStatusIndicator = (label: string, exists: boolean) => (
    <div className="flex items-center gap-1.5 text-xs">
      {exists ? (
        <CheckIcon className="h-3.5 w-3.5 text-green-600" />
      ) : processExited ? (
        <span className="inline-block h-3.5 w-3.5 rounded-full border border-red-400 bg-red-400/20" />
      ) : (
        <Spinner className="h-3.5 w-3.5 text-muted-fg" />
      )}
      <span className={exists ? "text-green-700" : "text-muted-fg"}>{label}</span>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-[4%] z-50 -translate-x-1/2 rounded-2xl bg-card/95 p-4 shadow-float backdrop-blur-xl focus:outline-none max-h-[92vh] overflow-y-auto ${
            phase === "running" || phase === "done"
              ? "w-[min(820px,calc(100vw-24px))]"
              : "w-[min(560px,calc(100vw-24px))]"
          }`}
        >
          <Dialog.Title className="text-sm font-semibold text-fg">
            Generate Context Docs
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            {phase === "configure" && "Configure and run an AI CLI to generate PRD and Architecture docs."}
            {phase === "running" && "Running — watch the terminal output below."}
            {phase === "done" && "Generation finished."}
          </Dialog.Description>

          {/* ======== Configure phase ======== */}
          {phase === "configure" && (
            <div className="mt-4 space-y-4">
              {noToolsInstalled && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
                  Install Claude Code or Codex CLI to generate docs.
                </div>
              )}

              {/* Provider selector */}
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Provider</label>
                <div className="flex gap-2">
                  {(["claude", "codex"] as const).map((p) => {
                    const tool = tools.find((t) => t.id === p);
                    const installed = tool?.installed ?? false;
                    return (
                      <button
                        key={p}
                        disabled={!installed}
                        onClick={() => setProvider(p)}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                          provider === p
                            ? "border-accent bg-accent/10 text-accent"
                            : installed
                              ? "border-border bg-bg text-fg hover:bg-muted/50"
                              : "border-border/50 bg-bg/50 text-muted-fg opacity-50"
                        }`}
                      >
                        {p === "claude" ? "Claude" : "Codex"}
                        {tool?.detectedVersion ? ` (${tool.detectedVersion})` : ""}
                        {!installed ? " — not installed" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Lane selector */}
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Lane / Worktree</label>
                <select
                  value={selectedLaneId}
                  onChange={(e) => setSelectedLaneId(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                >
                  {lanes.map((lane: LaneSummary) => (
                    <option key={lane.id} value={lane.id}>
                      {lane.name} ({lane.branchRef})
                    </option>
                  ))}
                </select>
              </div>

              {/* ---- Claude-specific options ---- */}
              {provider === "claude" && (
                <>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-fg">Permission Mode</label>
                    <div className="flex flex-wrap gap-2">
                      {([
                        { value: "bypass" as const, label: "Bypass permissions", desc: "--dangerously-skip-permissions" },
                        { value: "acceptEdits" as const, label: "Accept edits", desc: "--permission-mode acceptEdits" },
                        { value: "manual" as const, label: "Manual", desc: "You approve each action" }
                      ]).map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setClaudePermission(opt.value)}
                          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                            claudePermission === opt.value
                              ? "border-accent bg-accent/10 text-accent"
                              : "border-border bg-bg text-fg hover:bg-muted/50"
                          }`}
                        >
                          <div className="font-medium">{opt.label}</div>
                          <div className="text-[10px] text-muted-fg">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-fg">Multi-Agent</label>
                    <div className="flex flex-wrap gap-2">
                      {([
                        { value: "none" as const, label: "Single agent", desc: "Default behavior" },
                        { value: "parallel" as const, label: "Parallel subagents", desc: "Uses Task tool to spawn subagents" },
                        { value: "teams" as const, label: "Agent Teams", desc: "Experimental team coordination" }
                      ]).map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setClaudeMultiAgent(opt.value)}
                          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                            claudeMultiAgent === opt.value
                              ? "border-accent bg-accent/10 text-accent"
                              : "border-border bg-bg text-fg hover:bg-muted/50"
                          }`}
                        >
                          <div className="font-medium">{opt.label}</div>
                          <div className="text-[10px] text-muted-fg">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    {claudeMultiAgent === "teams" && (
                      <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
                        Agent Teams requires{" "}
                        <code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono text-[10px]">
                          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
                        </code>{" "}
                        in your <code className="font-mono text-[10px]">.claude/settings.json</code> env config.
                        The env var will be set inline for this run, but if your Claude Code config overrides it,
                        Claude will fall back to simple parallel subagents.
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ---- Codex-specific options ---- */}
              {provider === "codex" && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-fg">Approval Mode</label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { value: "fullAuto" as const, label: "Full auto", desc: "--full-auto (approve on-request + workspace-write)" },
                      { value: "autoEdit" as const, label: "Auto edit", desc: "Pause on failure only" },
                      { value: "suggest" as const, label: "Suggest", desc: "Pause before every command" },
                      { value: "manual" as const, label: "Manual", desc: "Default interactive mode" }
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setCodexApproval(opt.value)}
                        className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                          codexApproval === opt.value
                            ? "border-accent bg-accent/10 text-accent"
                            : "border-border bg-bg text-fg hover:bg-muted/50"
                        }`}
                      >
                        <div className="font-medium">{opt.label}</div>
                        <div className="text-[10px] text-muted-fg">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-2">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Cancel</Button>
                </Dialog.Close>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={noToolsInstalled || !selectedLaneId}
                  onClick={() => void handleRun()}
                >
                  Run
                </Button>
              </div>
            </div>
          )}

          {/* ======== Running phase ======== */}
          {phase === "running" && ptyId && sessionId && (
            <div className="mt-3">
              {/* Doc status bar */}
              <div className="mb-2 flex items-center gap-4 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                {docStatusIndicator("PRD", prdExists)}
                {docStatusIndicator("Architecture", archExists)}
                {docsReady && (
                  <span className="ml-auto text-xs font-medium text-green-700">Docs created</span>
                )}
              </div>

              <div className="h-[480px] w-full overflow-hidden rounded-lg border border-border">
                <TerminalView ptyId={ptyId} sessionId={sessionId} />
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void handleCancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* ======== Done phase ======== */}
          {phase === "done" && (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-3">
                {statusBadge()}
                {doneStatus === "completed" && docsReady && (
                  <span className="flex items-center gap-1 text-xs font-medium text-green-700">
                    <CheckIcon className="h-3.5 w-3.5" /> Docs installed
                  </span>
                )}
              </div>

              {/* Doc status */}
              <div className="flex items-center gap-4 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                {docStatusIndicator("PRD", prdExists)}
                {docStatusIndicator("Architecture", archExists)}
              </div>

              {doneStatus === "completed" && prepResult && (
                <div className="text-xs text-muted-fg space-y-1">
                  <div>PRD: {prepResult.outputPrdPath}</div>
                  <div>Architecture: {prepResult.outputArchPath}</div>
                </div>
              )}

              {installError && (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                  {installError}
                </div>
              )}

              {ptyId && sessionId && (
                <div className="h-[300px] w-full overflow-hidden rounded-lg border border-border">
                  <TerminalView ptyId={ptyId} sessionId={sessionId} />
                </div>
              )}

              <div className="flex justify-end">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Close</Button>
                </Dialog.Close>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Shell-safe quoting helper
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
