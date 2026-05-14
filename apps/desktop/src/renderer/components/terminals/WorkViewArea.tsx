import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Chats,
  Check,
  Code,
  Columns,
  Crosshair,
  DotsSixVertical,
  Funnel,
  GitBranch,
  GridFour,
  List,
  Plus,
  PaperPlaneTilt,
  Rows,
  SidebarSimple,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatModelInfo,
  AgentChatPermissionMode,
  AgentChatSession,
  AgentChatSlashCommand,
  ChatTerminalPreviewResult,
  LaneLinearIssue,
  LaneSummary,
  TerminalResumeProvider,
  TerminalSessionSummary,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
} from "../../../shared/types";
import { getRuntimeModelRefForDescriptor, resolveModelDescriptorForProvider } from "../../../shared/modelRegistry";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { LaneChip } from "./LaneChip";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { ChatCommandMenu, handleCommandMenuKeyDown, type ChatCommandMenuHandle, type ChatCommandMenuItem } from "../chat/ChatCommandMenu";
import { ChatComposerShell } from "../chat/ChatComposerShell";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { getPermissionOptions, safetyColors, type PermissionOption } from "../shared/permissionOptions";
import { WorkStartSurface } from "./WorkStartSurface";
import { WorkCliSessionHeader } from "./WorkCliSessionHeader";
import { isChatToolType, primarySessionLabel, stripTerminalLabelControls, truncateSessionLabel, formatToolTypeLabel } from "../../lib/sessions";
import { sessionStatusBucket, sessionStatusDot } from "../../lib/terminalAttention";
import type { WorkTabGroup } from "./useWorkSessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { useFloatingPaneEmbeddedChrome, type FloatingPaneEmbeddedChrome } from "../ui/FloatingPane";
import { PaneTilingLayout, type PaneConfig } from "../ui/PaneTilingLayout";
import { cn } from "../ui/cn";
import { launchProfileForTerminalSession, type LaunchProfile } from "./cliLaunch";
import { buildWorkSessionTilingTree, type TilingPreset } from "./workSessionTiling";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";

function isSessionAwaitingInput(session: TerminalSessionSummary): boolean {
  return sessionStatusBucket({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
  }) === "awaiting-input";
}

function isRunningPtySession(
  session: TerminalSessionSummary | null | undefined,
): session is TerminalSessionSummary & { ptyId: string } {
  return Boolean(
    session
    && session.status === "running"
    && session.ptyId
    && !isChatToolType(session.toolType),
  );
}

function isAgentCliSession(session: TerminalSessionSummary): boolean {
  return Boolean(
    session.toolType
    && session.toolType !== "shell"
    && session.toolType !== "run-shell"
    && !isChatToolType(session.toolType),
  );
}

function stoppedBySignal(exitCode: number | null | undefined): boolean {
  return exitCode === 130 || exitCode === 143;
}

function terminalExitLabel(exitCode: number | null | undefined): string | null {
  if (exitCode == null || exitCode === 0) return null;
  return stoppedBySignal(exitCode) ? "Stopped" : `Exit ${exitCode}`;
}

function stripTerminalControls(value: string): string {
  return stripTerminalLabelControls(value).replace(/\r(?!\n)/g, "\n");
}

const XTERM_16_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const;

function rgbColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  return `#${safe.toString(16).padStart(6, "0")}`;
}

function paletteColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const index = Math.max(0, Math.min(255, Math.floor(value)));
  if (index < XTERM_16_COLORS.length) return XTERM_16_COLORS[index];
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const r = Math.floor(offset / 36);
    const g = Math.floor((offset % 36) / 6);
    const b = offset % 6;
    const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
    return rgbColor((channel(r) << 16) + (channel(g) << 8) + channel(b));
  }
  const gray = 8 + (index - 232) * 10;
  return rgbColor((gray << 16) + (gray << 8) + gray);
}

function cellColor(mode: "default" | "palette" | "rgb", value: number | null): string | undefined {
  if (mode === "rgb") return rgbColor(value);
  if (mode === "palette") return paletteColor(value);
  return undefined;
}

function styleForSnapshotCell(cell: TerminalSnapshotCell): CSSProperties {
  let color = cellColor(cell.fgMode, cell.fg);
  let backgroundColor = cellColor(cell.bgMode, cell.bg);
  if (cell.inverse) {
    const nextColor = backgroundColor;
    backgroundColor = color;
    color = nextColor;
  }
  return {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(cell.bold ? { fontWeight: 700 } : {}),
    ...(cell.dim ? { opacity: 0.65 } : {}),
    ...(cell.italic ? { fontStyle: "italic" } : {}),
    ...(cell.underline || cell.strikethrough
      ? { textDecoration: [cell.underline ? "underline" : "", cell.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") }
      : {}),
  };
}

function styleKey(style: CSSProperties): string {
  return [
    style.color ?? "",
    style.backgroundColor ?? "",
    style.fontWeight ?? "",
    style.opacity ?? "",
    style.fontStyle ?? "",
    style.textDecoration ?? "",
  ].join("|");
}

function stableKeyHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function withStableDuplicateKeys<T>(
  items: T[],
  fingerprint: (item: T) => string,
): Array<{ item: T; key: string }> {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const base = stableKeyHash(fingerprint(item));
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return { item, key: count ? `${base}:${count}` : base };
  });
}

function isTrimmedBlankCell(cell: TerminalSnapshotCell | undefined): boolean {
  return Boolean(
    cell
    && (cell.text || " ") === " "
    && cell.bgMode === "default"
    && !cell.inverse,
  );
}

function snapshotRuns(row: TerminalSnapshotRow): Array<{ text: string; style: CSSProperties }> {
  let cells = row.cells;
  let end = cells.length;
  while (end > 1 && isTrimmedBlankCell(cells[end - 1])) end -= 1;
  cells = cells.slice(0, end);

  const runs: Array<{ text: string; style: CSSProperties }> = [];
  for (const cell of cells) {
    const text = cell.text || " ";
    const style = styleForSnapshotCell(cell);
    const last = runs[runs.length - 1];
    if (last && styleKey(last.style) === styleKey(style)) {
      last.text += text;
    } else {
      runs.push({ text, style });
    }
  }
  if (!runs.length) return [{ text: row.text || " ", style: {} }];
  return runs;
}

function TerminalSnapshotTranscript({ rows }: { rows: TerminalSnapshotRow[] }) {
  const renderedRows = useMemo(() => withStableDuplicateKeys(rows, (row) => [
    row.text,
    row.wrapped ? "wrapped" : "plain",
    ...row.cells.map((cell) => [
      cell.text,
      cell.fg,
      cell.bg,
      cell.fgMode,
      cell.bgMode,
      cell.bold ? "bold" : "",
      cell.dim ? "dim" : "",
      cell.italic ? "italic" : "",
      cell.underline ? "underline" : "",
      cell.inverse ? "inverse" : "",
      cell.strikethrough ? "strikethrough" : "",
    ].join("\u0001")),
  ].join("\u0002")).map(({ item: row, key }) => ({
    key,
    runs: withStableDuplicateKeys(snapshotRuns(row), (run) => `${run.text}\u0001${styleKey(run.style)}`),
  })), [rows]);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
      {renderedRows.map((row) => (
        <div key={row.key} className="min-h-[1.25em] whitespace-pre">
          {row.runs.map(({ item: run, key }) => (
            <span key={key} style={run.style}>
              {run.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

type CommandMenuAnchor = { top: number; left: number; bottom: number };

function getCommandMenuAnchor(element: HTMLElement | null): CommandMenuAnchor | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left + 16 };
}

function continuationProviderForSession(session: TerminalSessionSummary): TerminalResumeProvider | null {
  const profile = launchProfileForTerminalSession(session);
  return profile && profile !== "shell" ? profile : null;
}

function canContinueAgentCliSession(session: TerminalSessionSummary): boolean {
  return Boolean(session.tracked && continuationProviderForSession(session) && (session.resumeMetadata || session.resumeCommand));
}

function continuationProviderLabel(provider: TerminalResumeProvider | null): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor Agent";
  if (provider === "droid") return "Droid";
  if (provider === "opencode") return "OpenCode";
  return "agent CLI";
}

function continuationSupportsModelSelection(
  provider: TerminalResumeProvider | null,
): provider is "claude" | "codex" {
  return provider === "claude" || provider === "codex";
}

function canonicalContinuationModelId(provider: "claude" | "codex" | null, modelId: string): string {
  if (!provider) return modelId;
  return resolveModelDescriptorForProvider(modelId, provider)?.id ?? modelId;
}

function defaultContinuationModel(models: AgentChatModelInfo[], provider: "claude" | "codex" | null): string {
  const modelId = models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? "";
  return canonicalContinuationModelId(provider, modelId);
}

type WorkCliContinuationOptions = {
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode | null;
};

function continuationPermissionFamily(provider: TerminalResumeProvider | null): string | null {
  if (provider === "claude") return "anthropic";
  if (provider === "codex") return "openai";
  if (provider === "cursor") return "cursor";
  if (provider === "droid") return "factory";
  if (provider === "opencode") return "opencode";
  return null;
}

function continuationPermissionOptions(provider: TerminalResumeProvider | null): PermissionOption[] {
  const family = continuationPermissionFamily(provider);
  return family ? getPermissionOptions({ family, isCliWrapped: true }) : [];
}

function defaultContinuationPermissionMode(session: TerminalSessionSummary): AgentChatPermissionMode {
  const raw = session.resumeMetadata?.launch?.permissionMode ?? session.resumeMetadata?.permissionMode ?? "default";
  const options = continuationPermissionOptions(continuationProviderForSession(session));
  return options.some((option) => option.value === raw)
    ? raw
    : options[0]?.value ?? "default";
}

function defaultContinuationReasoningEffort(tiers: readonly string[] | null | undefined): string | null {
  if (!tiers?.length) return null;
  for (const preferred of ["high", "medium", "low"]) {
    if (tiers.includes(preferred)) return preferred;
  }
  return tiers[0] ?? null;
}

function runtimeModelForContinuation(provider: "claude" | "codex", modelId: string): string {
  const descriptor = resolveModelDescriptorForProvider(modelId, provider);
  return descriptor ? getRuntimeModelRefForDescriptor(descriptor, provider) : modelId;
}

function permissionSafetyDotClass(option: PermissionOption): string {
  if (option.safety === "safe") return "bg-emerald-400/80";
  if (option.safety === "semi-auto") return "bg-amber-400/80";
  if (option.safety === "full-auto" || option.safety === "danger") return "bg-red-400/80";
  return "bg-violet-400/80";
}

function WorkCliPermissionPicker({
  provider,
  value,
  onChange,
  disabled,
}: {
  provider: TerminalResumeProvider | null;
  value: AgentChatPermissionMode;
  onChange: (mode: AgentChatPermissionMode) => void;
  disabled?: boolean;
}) {
  const options = useMemo(() => continuationPermissionOptions(provider), [provider]);
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null;
  const providerLabel = continuationProviderLabel(provider);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const [open, setOpen] = useState(false);
  const updatePanelStyle = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportPadding = 8;
    const panelWidth = Math.min(352, Math.max(240, window.innerWidth - viewportPadding * 2));
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const maxHeight = Math.max(160, Math.min(360, (openAbove ? availableAbove : availableBelow) - 6));
    const left = Math.min(
      Math.max(viewportPadding, rect.right - panelWidth),
      Math.max(viewportPadding, window.innerWidth - panelWidth - viewportPadding),
    );
    const top = openAbove
      ? Math.max(viewportPadding, rect.top - maxHeight - 6)
      : Math.max(viewportPadding, Math.min(window.innerHeight - viewportPadding - maxHeight, rect.bottom + 6));
    setPanelStyle({ top, left, width: panelWidth, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePanelStyle();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      const panels = document.querySelectorAll("[data-cli-permission-picker-panel='true']");
      for (const panel of panels) {
        if (panel.contains(target)) return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePanelStyle);
    window.addEventListener("scroll", updatePanelStyle, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePanelStyle);
      window.removeEventListener("scroll", updatePanelStyle, true);
    };
  }, [open, updatePanelStyle]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  if (!selected) return null;

  const panel = createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="cli-permission-picker"
          data-cli-permission-picker-panel="true"
          className="fixed z-[82] overflow-y-auto rounded-xl border border-white/[0.10] bg-popover/95 p-1 shadow-2xl shadow-black/35 backdrop-blur-xl"
          style={panelStyle ?? undefined}
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.14 }}
        >
          {options.map((option) => {
            const optionColors = safetyColors(option.safety);
            const active = option.value === selected.value;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg border-l-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]",
                  optionColors.border,
                  active && optionColors.activeBg,
                )}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.03]">
                  {active ? <Check size={10} weight="bold" className="text-accent" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-semibold text-fg/85">{option.label}</span>
                    <span className={cn("shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em]", optionColors.badge)}>
                      {option.safety.replace("-", " ")}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted-fg/65">{option.shortDesc}</span>
                </span>
              </button>
            );
          })}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );

  return (
    <div ref={containerRef} className="relative min-w-0 shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (!open) updatePanelStyle();
            setOpen((current) => !current);
          }
        }}
        className={cn(
          "inline-flex h-8 min-h-8 max-w-[11rem] items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-[10px] font-medium text-fg/70 transition-colors hover:bg-white/[0.05]",
          open && "bg-white/[0.06]",
          disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
        )}
        aria-label={`${providerLabel} permission mode`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Permission mode: ${selected.label}`}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", permissionSafetyDotClass(selected))} />
        <span className="min-w-0 truncate">{selected.label}</span>
        <CaretDown size={10} weight="bold" className="shrink-0 text-muted-fg/45" />
      </button>
      {panel}
    </div>
  );
}

function WorkCliContinuationComposer({
  session,
  onContinue,
}: {
  session: TerminalSessionSummary;
  onContinue?: (session: TerminalSessionSummary, text: string, options?: WorkCliContinuationOptions) => Promise<void> | void;
}) {
  const provider = continuationProviderForSession(session);
  const providerLabel = continuationProviderLabel(provider);
  const modelProvider = continuationSupportsModelSelection(provider) ? provider : null;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);
  const [draft, setDraft] = useState("");
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [models, setModels] = useState<AgentChatModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<AgentChatPermissionMode>(() => defaultContinuationPermissionMode(session));
  const [modelsLoading, setModelsLoading] = useState(false);
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<{ type: "slash"; query: string; cursorIndex: number } | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<CommandMenuAnchor | null>(null);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const defaultPermissionMode = defaultContinuationPermissionMode(session);
  const availableModelIds = useMemo(
    () => models.map((model) => canonicalContinuationModelId(modelProvider, model.id)),
    [modelProvider, models],
  );

  useEffect(() => {
    let cancelled = false;
    setSlashCommands([]);
    if (!provider) return () => {
      cancelled = true;
    };
    void window.ade.agentChat.slashCommands({ laneId: session.laneId, provider })
      .then((commands) => {
        if (!cancelled) {
          setSlashCommands(commands.filter((command) => command.source !== "local"));
        }
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, session.laneId]);

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setSelectedModel("");
    setSelectedReasoningEffort(null);
    if (!modelProvider) return () => {
      cancelled = true;
    };
    setModelsLoading(true);
    void window.ade.agentChat.models({ provider: modelProvider })
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        setSelectedModel((current) => (
          current && rows.some((model) => canonicalContinuationModelId(modelProvider, model.id) === current)
            ? current
            : defaultContinuationModel(rows, modelProvider)
        ));
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setSelectedModel("");
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelProvider]);

  useEffect(() => {
    setSelectedPermissionMode(defaultPermissionMode);
  }, [defaultPermissionMode, session.id]);

  useEffect(() => {
    if (!modelProvider || !selectedModel) {
      setSelectedReasoningEffort(null);
      return;
    }
    const descriptor = resolveModelDescriptorForProvider(selectedModel, modelProvider);
    const tiers = descriptor?.reasoningTiers ?? [];
    setSelectedReasoningEffort((current) => (
      current && tiers.includes(current)
        ? current
        : defaultContinuationReasoningEffort(tiers)
    ));
  }, [modelProvider, selectedModel]);

  const updateDraft = useCallback((next: string, element: HTMLTextAreaElement | null) => {
    setDraft(next);
    setSubmitError(null);
    if (next.startsWith("/") && !next.slice(1).includes("\n")) {
      const afterSlash = next.slice(1);
      if (!/\s/.test(afterSlash)) {
        const query = afterSlash.match(/^[^\s/]*/)?.[0] ?? "";
        setCommandMenuTrigger({ type: "slash", query, cursorIndex: 0 });
        const anchor = getCommandMenuAnchor(element);
        if (anchor) setCommandMenuAnchor(anchor);
        return;
      }
    }
    setCommandMenuTrigger(null);
  }, []);

  const handleCommandSelect = useCallback((item: ChatCommandMenuItem) => {
    if (item.type !== "command") return;
    const command = slashCommands.find((candidate) => candidate.name.replace(/^\//, "") === item.name);
    const argumentHint = command?.argumentHint ? ` ${command.argumentHint}` : "";
    const next = `/${item.name}${argumentHint} `;
    setDraft(next);
    setCommandMenuTrigger(null);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [slashCommands]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSubmitError(null);
    try {
      const options: WorkCliContinuationOptions = {
        permissionMode: selectedPermissionMode,
      };
      if (modelProvider && selectedModel) {
        options.model = runtimeModelForContinuation(modelProvider, selectedModel);
      }
      if (selectedReasoningEffort) {
        options.reasoningEffort = selectedReasoningEffort;
      }
      await onContinue?.(session, text, options);
      setDraft("");
      setCommandMenuTrigger(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, modelProvider, onContinue, selectedModel, selectedPermissionMode, selectedReasoningEffort, sending, session]);

  return (
    <div className="shrink-0">
      <ChatComposerShell
        mode="standard"
        className="rounded-lg border border-white/[0.08] bg-white/[0.025]"
        footer={(
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-[10px] text-muted-fg/55">
            <div className="min-w-0 shrink truncate px-1">
              <span className="font-medium text-fg/70">{providerLabel}</span>
            </div>
            {modelProvider ? (
              <ProviderModelSelector
                value={selectedModel}
                disabled={sending || modelsLoading || models.length === 0}
                onChange={setSelectedModel}
                availableModelIds={availableModelIds}
                catalogMode="available-only"
                filter={(model) => (
                  modelProvider === "claude"
                    ? model.family === "anthropic" && model.isCliWrapped
                    : model.family === "openai" && model.isCliWrapped
                )}
                compactToolbar
                showReasoning
                reasoningEffort={selectedReasoningEffort}
                onReasoningEffortChange={setSelectedReasoningEffort}
              />
            ) : null}
            <WorkCliPermissionPicker
              provider={provider}
              value={selectedPermissionMode}
              onChange={setSelectedPermissionMode}
              disabled={sending}
            />
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void submit()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {sending ? <SpinnerGap size={12} className="animate-spin" /> : <PaperPlaneTilt size={12} weight="fill" />}
              Send
            </button>
          </div>
        )}
      >
        <ChatCommandMenu
          ref={commandMenuRef}
          trigger={commandMenuTrigger}
          slashCommands={slashCommands.map((command) => ({
            name: command.name.replace(/^\//, ""),
            description: command.description,
            argumentHint: command.argumentHint,
            source: command.source,
          }))}
          sessionId={null}
          anchor={commandMenuAnchor}
          onSelect={handleCommandSelect}
          onClose={() => setCommandMenuTrigger(null)}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={sending}
          onChange={(event) => updateDraft(event.currentTarget.value, event.currentTarget)}
          onKeyDown={(event) => {
            if (commandMenuTrigger && handleCommandMenuKeyDown(event, commandMenuRef, () => setCommandMenuTrigger(null))) {
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className="block max-h-32 min-h-[3rem] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-fg/88 outline-none placeholder:text-muted-fg/35 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder={`Type to continue this ${providerLabel} session...`}
          aria-label={`Continue ${providerLabel} session`}
        />
      </ChatComposerShell>
      {submitError ? (
        <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {submitError}
        </div>
      ) : null}
    </div>
  );
}

function ClosedCliSessionSurface({
  session,
  layoutVariant,
  onInfoClick,
  onContextMenu,
  onContinue,
}: {
  session: TerminalSessionSummary;
  layoutVariant: "standard" | "grid-tile";
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContinue?: (session: TerminalSessionSummary, text: string, options?: WorkCliContinuationOptions) => Promise<void> | void;
}) {
  const [preview, setPreview] = useState<ChatTerminalPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = primarySessionLabel(session);
  const showComposer = canContinueAgentCliSession(session);
  const exitLabel = terminalExitLabel(session.exitCode);
  const endedTime = session.endedAt
    ? new Date(session.endedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void window.ade.terminal.preview({ terminalId: session.id, maxBytes: 160_000 })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.endedAt, session.status]);

  const snapshotRows = preview?.snapshot?.visibleRows ?? [];
  const useSnapshotPreview = snapshotRows.length > 0 && (
    preview?.session?.status === "running"
    || !preview?.transcript
  );
  const transcriptText = stripTerminalControls(preview?.transcript ?? "").trimEnd()
    || session.lastOutputPreview
    || session.summary
    || "No transcript was captured for this session.";

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card">
      <WorkCliSessionHeader
        session={session}
        compact={layoutVariant === "grid-tile"}
        onInfoClick={onInfoClick}
        onContextMenu={onContextMenu}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium text-fg/85">{label}</div>
            <div className="mt-0.5 text-[10px] text-muted-fg/55">
              {endedTime ? `Ended ${endedTime}` : "Session ended"}
              {exitLabel ? ` · ${exitLabel}` : ""}
            </div>
          </div>
        </div>
        {error ? (
          <div className="shrink-0 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            {error}
          </div>
        ) : null}
        {useSnapshotPreview ? (
          <TerminalSnapshotTranscript rows={snapshotRows} />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
            {transcriptText}
          </pre>
        )}
        {showComposer ? <WorkCliContinuationComposer session={session} onContinue={onContinue} /> : null}
      </div>
    </div>
  );
}

function SessionSurface({
  session,
  isActive,
  pageActive = true,
  shouldAutofocus = false,
  layoutVariant = "standard",
  terminalVisible = isActive,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
  stopping = false,
  onOpenChatSession,
  onContinueCliSession,
}: {
  session: TerminalSessionSummary;
  isActive: boolean;
  pageActive?: boolean;
  shouldAutofocus?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  terminalVisible?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
  stopping?: boolean;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onContinueCliSession?: (session: TerminalSessionSummary, text: string, options?: WorkCliContinuationOptions) => Promise<void> | void;
}) {
  const isChat = isChatToolType(session.toolType);
  const surfaceActive = pageActive && isActive;
  const surfaceVisible = pageActive && (layoutVariant === "grid-tile" ? true : isActive);
  if (isChat) {
    return (
      <AgentChatPane
        laneId={session.laneId}
        laneLabel={session.laneName}
        lockSessionId={session.id}
        hideSessionTabs
        hideLaneToolDrawers
        onSessionCreated={onOpenChatSession}
        layoutVariant={layoutVariant}
        isTileActive={surfaceActive}
        isTileVisible={surfaceVisible}
        shouldAutofocusComposer={surfaceActive && shouldAutofocus}
      />
    );
  }
  if (isRunningPtySession(session)) {
    if (isAgentCliSession(session)) {
      return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
          <WorkCliSessionHeader
            session={session}
            compact={layoutVariant === "grid-tile"}
            stopping={stopping}
            onInfoClick={onInfoClick}
            onContextMenu={onContextMenu}
            onStopRunningSession={onStopRunningSession}
          />
          <TerminalView
            key={session.id}
            ptyId={session.ptyId}
            sessionId={session.id}
            isActive={surfaceActive}
            isVisible={pageActive && terminalVisible}
            className="min-h-0 w-full flex-1"
          />
        </div>
      );
    }
    return (
      <TerminalView
        key={session.id}
        ptyId={session.ptyId}
        sessionId={session.id}
        isActive={surfaceActive}
        isVisible={pageActive && terminalVisible}
        className="h-full w-full"
      />
    );
  }

  if (isAgentCliSession(session)) {
    return (
      <ClosedCliSessionSurface
        session={session}
        layoutVariant={layoutVariant}
        onInfoClick={onInfoClick}
        onContextMenu={onContextMenu}
        onContinue={onContinueCliSession}
      />
    );
  }

  const label = primarySessionLabel(session);
  const toolLabel = session.toolType ? formatToolTypeLabel(session.toolType) : null;
  const rawSummary = session.summary?.trim() || session.goal?.trim() || null;
  // Don't show summary if it just repeats the title
  const summary = rawSummary && rawSummary !== label && !rawSummary.startsWith(label) ? rawSummary : null;
  const endedTime = session.endedAt
    ? new Date(session.endedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const exitLabel = terminalExitLabel(session.exitCode);

  return (
    <div
      className="flex h-full w-full items-center justify-center px-6"
      style={{
        background: "radial-gradient(circle at top, color-mix(in srgb, var(--color-fg) 5%, transparent) 0%, transparent 42%), var(--color-card)",
      }}
    >
      <div className="ade-liquid-glass-menu flex w-full max-w-md flex-col gap-4 rounded-lg px-5 py-5">
        {/* Header: tool logo + session name */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: "rgba(255,255,255,0.05)" }}>
            <ToolLogo toolType={session.toolType} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">{label}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-fg/70">
              {toolLabel && <span>{toolLabel}</span>}
              {toolLabel && endedTime && <span>·</span>}
              {endedTime && <span>Ended {endedTime}</span>}
              {exitLabel && (
                <>
                  <span>·</span>
                  <span className={stoppedBySignal(session.exitCode) ? "text-amber-300" : "text-red-400"}>{exitLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Summary */}
        {summary && (
          <div className="text-[12px] leading-relaxed text-muted-fg">
            {summary.length > 300 ? `${summary.slice(0, 300).trimEnd()}…` : summary}
          </div>
        )}

        {/* Session ID */}
        <div className="flex items-center gap-2 text-[10px] text-muted-fg/50">
          <span className="font-mono">{session.id}</span>
        </div>

      </div>
    </div>
  );
}

const MODE_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  description: string;
  Icon: typeof Chats;
}> = [
  { kind: "chat", label: "Chat", description: "Compose a new ADE chat in this lane.", Icon: Chats },
  { kind: "cli", label: "CLI", description: "Start a tracked agent CLI session.", Icon: Code },
];

type SessionsPaneExpandAffordanceProps = {
  show: boolean;
  onExpand: () => void;
  listCount: number;
  runningCount: number;
  listLoading: boolean;
};

function SessionsPaneExpandAffordance({
  show,
  onExpand,
  listCount,
  runningCount,
  listLoading,
}: SessionsPaneExpandAffordanceProps) {
  if (!show) return null;
  let countHint: string;
  if (listLoading) {
    countHint = "Loading session list…";
  } else if (listCount > 0) {
    countHint = `${listCount} in list${runningCount > 0 ? `, ${runningCount} running` : ""}`;
  } else {
    countHint = "Session list is empty.";
  }
  return (
    <SmartTooltip
      content={{
        label: "Show sessions",
        description: `Expand the sessions sidebar. ${countHint}`,
      }}
    >
      <button
        type="button"
        className="ade-shell-control inline-flex shrink-0 items-center gap-1 px-1.5 py-1 text-[11px] font-medium"
        data-variant="ghost"
        data-tour="work.focusToolbar"
        onClick={onExpand}
      >
        <SidebarSimple size={13} weight="regular" />
        {!listLoading && listCount > 0 ? (
          <span className="min-w-[1ch] text-[10px] tabular-nums text-muted-fg/50">{listCount}</span>
        ) : null}
      </button>
    </SmartTooltip>
  );
}

function ModeSwitcherPills({
  draftKind,
  onShowDraftKind,
}: {
  draftKind: WorkDraftKind;
  onShowDraftKind: (kind: WorkDraftKind) => void;
}) {
  return (
    <div className="ade-liquid-glass-pill inline-flex items-center gap-0.5 rounded-full p-1">
      {MODE_OPTIONS.map((opt) => {
        const active = draftKind === opt.kind;
        const Icon = opt.Icon;
        return (
          <SmartTooltip
            key={opt.kind}
            content={{
              label: opt.label,
              description: opt.description,
              effect: active ? "This start mode is selected." : undefined,
            }}
          >
            <button
              type="button"
              className={cn(
                "inline-flex min-h-[36px] items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium transition-all",
                active && "ade-work-tab-active",
              )}
              style={{
                background: active ? undefined : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                cursor: "pointer",
                border: "none",
              }}
              onClick={() => onShowDraftKind(opt.kind)}
            >
              <Icon size={15} weight="regular" className="shrink-0 opacity-80" />
              {opt.label}
            </button>
          </SmartTooltip>
        );
      })}
    </div>
  );
}

function WorkPaneEmbeddedChromeLeading({ chrome }: { chrome: FloatingPaneEmbeddedChrome | null }) {
  if (!chrome?.minimizable) return null;
  const { onMinimizeToggle, minimized, dragHandleProps } = chrome;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {dragHandleProps?.draggable ? (
        <DotsSixVertical
          size={10}
          weight="regular"
          className="pointer-events-none text-muted-fg/30 shrink-0"
          aria-hidden
        />
      ) : null}
      <button
        type="button"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
          minimized ? "text-accent" : "text-muted-fg/50 hover:text-fg"
        )}
        onClick={(event) => {
          event.stopPropagation();
          onMinimizeToggle();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title={minimized ? "Expand pane" : "Minimize pane"}
        aria-label={minimized ? "Expand pane" : "Minimize pane"}
      >
        {minimized ? <CaretRight size={12} weight="regular" /> : <CaretDown size={12} weight="regular" />}
      </button>
    </div>
  );
}

function AdeToolsPaneGlyph({ open }: { open: boolean }) {
  return (
    <span className="relative block h-4 w-[18px]" aria-hidden="true">
      <span
        className={cn(
          "absolute left-0 top-0.5 h-3.5 w-[17px] rounded-[5px] border transition-colors",
          open
            ? "border-sky-300/45 bg-sky-300/[0.09]"
            : "border-white/20 bg-white/[0.035]",
        )}
      />
      <span
        className={cn(
          "absolute right-[2px] top-[3px] h-2.5 w-[5px] rounded-[3px] transition-colors",
          open ? "bg-sky-200/85 shadow-[0_0_10px_rgba(125,211,252,0.28)]" : "bg-muted-fg/55",
        )}
      />
      <span className={cn("absolute left-[3px] top-[5px] h-[2px] w-[7px] rounded-full", open ? "bg-sky-100/80" : "bg-current/65")} />
      <span className={cn("absolute left-[3px] top-[9px] h-[2px] w-[5px] rounded-full", open ? "bg-sky-100/45" : "bg-current/35")} />
    </span>
  );
}

function WorkSidebarToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle) return null;
  return (
    <SmartTooltip
      content={{
        label: open ? "Hide ADE tools pane" : "Open ADE tools pane",
        description: "Keep Git, Files, iOS Simulator, App Control, Browser, and macOS VM context beside this Work session.",
      }}
    >
      <button
        type="button"
        className={cn(
          "ade-shell-control inline-flex h-7 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08]",
          "bg-white/[0.035] text-muted-fg/75 transition-colors hover:bg-white/[0.07] hover:text-fg/90",
          open && "ade-work-tab-active",
        )}
        data-variant="ghost"
        onClick={onToggle}
        aria-label={open ? "Hide ADE tools pane" : "Open ADE tools pane"}
        aria-pressed={open}
      >
        <AdeToolsPaneGlyph open={open} />
      </button>
    </SmartTooltip>
  );
}

type WorkTabProps = {
  session: TerminalSessionSummary;
  isActive: boolean;
  isBusy: boolean;
  laneColor: string | null;
  grouped?: boolean;
  awaiting: boolean;
  dropEdge?: "before" | "after" | null;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  dragProps?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
};

function WorkTab({
  session,
  isActive,
  isBusy,
  laneColor,
  grouped = false,
  awaiting,
  dropEdge = null,
  onSelect,
  onClose,
  onContextMenu,
  dragProps,
}: WorkTabProps) {
  const dot = sessionStatusDot(session);
  const primary = primarySessionLabel(session);
  const trimmedLaneColor = laneColor?.trim() || null;
  const tabTint = trimmedLaneColor
    ? `color-mix(in srgb, ${trimmedLaneColor} ${isActive ? 22 : 8}%, transparent)`
    : "transparent";
  const ring = trimmedLaneColor
    ? `color-mix(in srgb, ${trimmedLaneColor} ${isActive ? 40 : 24}%, transparent)`
    : "color-mix(in srgb, var(--color-fg) 18%, transparent)";
  const cssVars = {
    "--lane-tab-tint": tabTint,
    "--lane-tab-active-ring": ring,
    "--lane-drop-indicator": trimmedLaneColor ?? "color-mix(in srgb, var(--color-fg) 60%, transparent)",
  } as React.CSSProperties;
  return (
    <SmartTooltip
      content={{
        label: truncateSessionLabel(primary, 28),
        description: `Switch to this ${formatToolTypeLabel(session.toolType)} work tab.`,
        effect: dot.label,
      }}
    >
      <div
        className={cn(
          "group/tab ade-work-tab",
          grouped && "ade-work-tab--grouped",
          isActive && "ade-work-tab--active",
          awaiting && "ade-work-tab--awaiting",
          dropEdge === "before" && "ade-work-tab--drop-before",
          dropEdge === "after" && "ade-work-tab--drop-after",
        )}
        style={cssVars}
        onContextMenu={onContextMenu}
        draggable={dragProps?.draggable ?? false}
        onDragStart={dragProps?.onDragStart}
        onDragEnter={dragProps?.onDragEnter}
        onDragOver={dragProps?.onDragOver}
        onDragLeave={dragProps?.onDragLeave}
        onDrop={dragProps?.onDrop}
        onDragEnd={dragProps?.onDragEnd}
      >
        <button
          type="button"
          role="tab"
          tabIndex={0}
          aria-selected={isActive}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onSelect();
          }}
          style={{
            all: "unset",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
            height: "100%",
            cursor: "pointer",
          }}
        >
          <ToolLogo toolType={session.toolType} size={18} />
          <span className="max-w-[160px] truncate">
            {truncateSessionLabel(primary, 24)}
          </span>
          <span
            title={dot.label}
            className={`${dot.cls} h-1.5 w-1.5 shrink-0${dot.spinning ? " animate-spin" : ""}`}
          />
        </button>
        <button
          type="button"
          data-close-tab-session-id={session.id}
          title={isBusy ? "Removing..." : "Remove from Work view"}
          className="inline-flex items-center justify-center opacity-0 group-hover/tab:opacity-100 transition-opacity"
          style={{
            width: 14,
            height: 14,
            padding: 0,
            border: 0,
            background: "transparent",
            cursor: isBusy ? "default" : "pointer",
            color: "var(--color-muted-fg)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (isBusy) return;
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (isBusy) return;
              onClose();
            }
          }}
        >
          <X size={9} />
        </button>
      </div>
    </SmartTooltip>
  );
}

export function WorkViewArea({
  pageActive = true,
  gridLayoutId,
  lanes,
  sessions,
  visibleSessions,
  tabGroups,
  tabVisibleSessionIds,
  activeItemId,
  viewMode,
  draftKind,
  draftLaneId = null,
  onContinueCliSession,
  setViewMode,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onDraftLaneChange,
  onShowDraftKind,
  onToggleTabGroupCollapsed,
  closingPtyIds,
  onContextMenu,
  sessionsPaneCollapsed = false,
  onExpandSessionsPane,
  sessionsPaneListCount = 0,
  sessionsPaneRunningCount = 0,
  sessionsListLoading = false,
  workSidebarOpen = false,
  onToggleWorkSidebar,
  initialLinearIssueContext = null,
  onInitialLinearIssueContextConsumed,
  onReorderLaneSessions,
  onOpenSessionInTabsView,
  onGoToLane,
  onInfoClick,
  onStopRunningSession,
}: {
  pageActive?: boolean;
  gridLayoutId: string;
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  tabGroups?: WorkTabGroup[];
  tabVisibleSessionIds?: string[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  draftLaneId?: string | null;
  setViewMode: (mode: WorkViewMode) => void;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: {
    laneId: string;
    profile: LaunchProfile;
    title?: string;
    startupCommand?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    tracked?: boolean;
  }) => Promise<unknown>;
  onDraftLaneChange?: (laneId: string) => void;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onToggleTabGroupCollapsed?: (groupId: string) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContinueCliSession?: (session: TerminalSessionSummary, text: string, options?: WorkCliContinuationOptions) => Promise<void> | void;
  onReorderLaneSessions?: (laneId: string, movedSessionId: string, targetSessionId: string, edge: "before" | "after") => void;
  onOpenSessionInTabsView?: (sessionId: string) => void;
  onGoToLane?: (laneId: string) => void;
  /** When the work sessions list pane is collapsed, show expand control in the work header. */
  sessionsPaneCollapsed?: boolean;
  onExpandSessionsPane?: () => void;
  sessionsPaneListCount?: number;
  sessionsPaneRunningCount?: number;
  sessionsListLoading?: boolean;
  workSidebarOpen?: boolean;
  onToggleWorkSidebar?: () => void;
  initialLinearIssueContext?: LaneLinearIssue | null;
  onInitialLinearIssueContextConsumed?: () => void;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const expandSessionsProps: SessionsPaneExpandAffordanceProps = {
    show: Boolean(sessionsPaneCollapsed && onExpandSessionsPane),
    onExpand: onExpandSessionsPane ?? (() => {}),
    listCount: sessionsPaneListCount,
    runningCount: sessionsPaneRunningCount,
    listLoading: sessionsListLoading,
  };
  const workEmbeddedChrome = useFloatingPaneEmbeddedChrome();
  const glassHeaderDragProps = workEmbeddedChrome?.dragHandleProps ?? {};
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const laneColorById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const lane of lanes) map.set(lane.id, lane.color);
    return map;
  }, [lanes]);

  const tabVisibleSessions = useMemo(
    () => (tabVisibleSessionIds ?? visibleSessions.map((session) => session.id))
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null),
    [sessionsById, tabVisibleSessionIds, visibleSessions],
  );
  const showingDraft = activeItemId == null;
  const activeSession = showingDraft
    ? null
    : sessionsById.get(activeItemId) ?? tabVisibleSessions[0] ?? visibleSessions[0] ?? null;
  const handleContextMenu = useCallback((session: TerminalSessionSummary, e: React.MouseEvent): void => {
    if (onContextMenu) {
      e.preventDefault();
      onContextMenu(session, e);
    }
  }, [onContextMenu]);
  const [tilingPreset, setTilingPreset] = useState<TilingPreset>("auto");
  const gridSessionIdsKey = JSON.stringify(visibleSessions.map((session) => session.id));
  const gridTree = useMemo(
    () => buildWorkSessionTilingTree(JSON.parse(gridSessionIdsKey) as string[], tilingPreset),
    [gridSessionIdsKey, tilingPreset],
  );
  const applyTilingPreset = useCallback(async (preset: TilingPreset) => {
    const ids = JSON.parse(gridSessionIdsKey) as string[];
    const nextTree = buildWorkSessionTilingTree(ids, preset);
    try {
      await Promise.all([
        window.ade.tilingTree.set(gridLayoutId, nextTree),
        window.ade.layout.set(gridLayoutId, {}),
      ]);
    } catch {
      /* persistence is best-effort; UI state update below still applies */
    }
    setTilingPreset(preset);
  }, [gridLayoutId, gridSessionIdsKey]);
  const tilingPanes = useMemo<Record<string, PaneConfig>>(() => Object.fromEntries(
    visibleSessions.map((session) => {
      const dot = sessionStatusDot(session);
      const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
      const isActive = activeItemId === session.id;
      const rawLaneColor = laneColorById.get(session.laneId) ?? null;
      const laneAccentColor = rawLaneColor?.trim() ? rawLaneColor.trim() : null;
      const openInTabs = () => onOpenSessionInTabsView?.(session.id);
      const gotoLane = () => onGoToLane?.(session.laneId);
      return [session.id, {
        title: truncateSessionLabel(primarySessionLabel(session)),
        meta: (
          <span className="inline-flex items-center gap-2">
            <ToolLogo toolType={session.toolType} size={18} />
          </span>
        ),
        minimizable: false,
        laneAccentColor,
        className: cn("h-full ade-work-glass-tile", isActive && "ade-work-glass-tile-active"),
        bodyClassName: "overflow-hidden",
        headerActions: (
          <>
            <LaneChip
              laneName={session.laneName}
              laneColor={laneAccentColor}
              maxWidth={120}
              onClick={gotoLane}
            />
            <span
              title={dot.label}
              className={`${dot.cls} h-2 w-2 shrink-0${dot.spinning ? " animate-spin" : ""}`}
            />
            <SmartTooltip content={{ label: "Open in Tabs view", description: "Switch to the single-pane tab view focused on this session." }}>
              <button
                type="button"
                onClick={openInTabs}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Open in Tabs view"
                className="inline-flex h-5 w-5 items-center justify-center text-muted-fg/55 transition-colors hover:text-fg"
                style={{ border: "none", background: "transparent", cursor: "pointer" }}
              >
                <ArrowSquareOut size={11} />
              </button>
            </SmartTooltip>
            <SmartTooltip content={{ label: "Go to lane", description: "Switch the active lane to this session's lane." }}>
              <button
                type="button"
                onClick={gotoLane}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Go to lane"
                className="inline-flex h-5 w-5 items-center justify-center text-muted-fg/55 transition-colors hover:text-fg"
                style={{ border: "none", background: "transparent", cursor: "pointer" }}
              >
                <Crosshair size={11} />
              </button>
            </SmartTooltip>
            <button
              type="button"
              onClick={() => onCloseItem(session.id)}
              onMouseDown={(e) => e.stopPropagation()}
              title={isBusy ? "Removing..." : "Remove from Work view"}
              disabled={isBusy}
              className="inline-flex h-5 w-5 items-center justify-center text-muted-fg/50 transition-colors hover:text-fg"
              style={{
                border: "none",
                background: "transparent",
                cursor: isBusy ? "default" : "pointer",
                opacity: isBusy ? 0.4 : 1,
              }}
            >
              <X size={10} />
            </button>
          </>
        ),
        onPaneMouseDown: () => onSelectItem(session.id),
        onPaneContextMenu: (e) => handleContextMenu(session, e),
        children: (
          <div className="min-h-0 h-full flex-1 overflow-hidden">
            <SessionSurface
              session={session}
              isActive={isActive}
              pageActive={pageActive}
              shouldAutofocus={isActive}
              terminalVisible
              layoutVariant="grid-tile"
              onInfoClick={onInfoClick}
              onContextMenu={onContextMenu}
              onStopRunningSession={onStopRunningSession}
              stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
              onOpenChatSession={onOpenChatSession}
              onContinueCliSession={onContinueCliSession}
            />
          </div>
        ),
      } satisfies PaneConfig];
    }),
  ), [
    activeItemId,
    closingPtyIds,
    handleContextMenu,
    laneColorById,
    onCloseItem,
    onContextMenu,
    onGoToLane,
    onInfoClick,
    onOpenChatSession,
    onOpenSessionInTabsView,
    onContinueCliSession,
    onSelectItem,
    onStopRunningSession,
    pageActive,
    visibleSessions,
  ]);
  const resolvedTabGroups = tabGroups ?? [];
  const hasGroupedTabs = resolvedTabGroups.length > 0;
  const toggleTabGroupCollapsed = onToggleTabGroupCollapsed ?? (() => {});

  const [dragState, setDragState] = useState<{
    laneId: string;
    sessionId: string;
    overIndex: number | null;
    overEdge: "before" | "after" | null;
  } | null>(null);

  const buildLaneDragProps = useCallback((args: {
    laneId: string;
    sessionId: string;
    index: number;
  }): WorkTabProps["dragProps"] => {
    if (!onReorderLaneSessions) return undefined;
    return {
      draggable: true,
      onDragStart: (e) => {
        try { e.dataTransfer.setData("text/x-ade-work-tab", args.sessionId); } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = "move";
        setDragState({ laneId: args.laneId, sessionId: args.sessionId, overIndex: null, overEdge: null });
      },
      onDragEnter: (e) => {
        if (!dragState || dragState.laneId !== args.laneId) return;
        e.preventDefault();
      },
      onDragOver: (e) => {
        if (!dragState || dragState.laneId !== args.laneId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const edge: "before" | "after" = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
        setDragState((prev) => (
          prev && prev.laneId === args.laneId && (prev.overIndex !== args.index || prev.overEdge !== edge)
            ? { ...prev, overIndex: args.index, overEdge: edge }
            : prev
        ));
      },
      onDragLeave: () => {
        setDragState((prev) => (
          prev && prev.overIndex === args.index ? { ...prev, overIndex: null, overEdge: null } : prev
        ));
      },
      onDrop: (e) => {
        e.preventDefault();
        if (!dragState || dragState.laneId !== args.laneId || dragState.sessionId === args.sessionId) return;
        const targetEdge = dragState.overEdge ?? "before";
        onReorderLaneSessions(args.laneId, dragState.sessionId, args.sessionId, targetEdge);
        setDragState(null);
      },
      onDragEnd: () => setDragState(null),
    };
  }, [dragState, onReorderLaneSessions]);

  if (viewMode === "grid") {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <div
          className={cn(
            "ade-work-glass-header flex w-full min-w-0 max-w-full shrink-0 items-center gap-3 px-3 py-1.5",
            workEmbeddedChrome?.dragHandleProps?.draggable && "cursor-grab active:cursor-grabbing"
          )}
          {...glassHeaderDragProps}
        >
          <SessionsPaneExpandAffordance {...expandSessionsProps} />
          <WorkPaneEmbeddedChromeLeading chrome={workEmbeddedChrome} />
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          <span className="text-[11px] font-medium text-muted-fg">Grid</span>
          <span className="ade-liquid-glass-pill inline-flex items-center px-1.5 text-[10px] text-muted-fg/60 rounded">
            {visibleSessions.length}
          </span>
          {visibleSessions.length > 1 ? (
            <ArrangeMenu preset={tilingPreset} onSelect={applyTilingPreset} />
          ) : null}
          <div className="ml-auto shrink-0">
            <WorkSidebarToggle open={workSidebarOpen} onToggle={onToggleWorkSidebar} />
          </div>
        </div>

        {visibleSessions.length === 0 ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-center py-3">
              <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
            </div>
            <div className="min-h-0 flex-1">
              <WorkStartSurface
                draftKind={draftKind}
                draftLaneId={draftLaneId}
                lanes={lanes}
                onOpenChatSession={onOpenChatSession}
                onLaunchPtySession={onLaunchPtySession}
                onDraftLaneChange={onDraftLaneChange}
                initialLinearIssueContext={initialLinearIssueContext}
                onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
              />
            </div>
          </div>
        ) : (
          <PaneTilingLayout
            key={`${gridLayoutId}:${tilingPreset}`}
            layoutId={gridLayoutId}
            tree={gridTree}
            panes={tilingPanes}
            className="ade-work-grid-tiling flex-1 min-h-0 px-2 pb-2"
          />
        )}
      </div>
    );
  }

  /* ---- Tab view ---- */
  const tabBody = (
    <div className="relative min-h-0 flex-1" style={{ background: "var(--color-bg)" }}>
      {visibleSessions.map((session) => {
        const isActive = activeSession?.id === session.id;

        return (
          <div
            key={session.id}
            className="absolute inset-0"
            hidden={!isActive}
          >
            <SessionSurface
              session={session}
              isActive={isActive}
              pageActive={pageActive}
              terminalVisible={isActive}
              onInfoClick={onInfoClick}
              onContextMenu={onContextMenu}
              onStopRunningSession={onStopRunningSession}
              stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
              onOpenChatSession={onOpenChatSession}
              onContinueCliSession={onContinueCliSession}
            />
          </div>
        );
      })}

      {!activeSession ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="flex shrink-0 items-center justify-center py-3">
            <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
          </div>
          <div className="min-h-0 flex-1">
            <WorkStartSurface
              draftKind={draftKind}
              draftLaneId={draftLaneId}
              lanes={lanes}
              onOpenChatSession={onOpenChatSession}
              onLaunchPtySession={onLaunchPtySession}
              onDraftLaneChange={onDraftLaneChange}
              initialLinearIssueContext={initialLinearIssueContext}
              onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
            />
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!hasGroupedTabs) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <div
          className={cn(
            "ade-work-glass-header flex min-h-10 w-full min-w-0 max-w-full shrink-0 items-center gap-0 px-1.5 py-1.5",
            workEmbeddedChrome?.dragHandleProps?.draggable && "cursor-grab active:cursor-grabbing"
          )}
          style={{
            minHeight: 40,
            maxHeight: 44,
          }}
          {...glassHeaderDragProps}
        >
          <SessionsPaneExpandAffordance {...expandSessionsProps} />
          <WorkPaneEmbeddedChromeLeading chrome={workEmbeddedChrome} />
          <div className="shrink-0">
            <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
          </div>
          <div className="ade-work-tab-strip-scroll min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="ade-work-tab-strip-roomy w-max min-w-0">
            {visibleSessions.map((session, index) => {
              const isActive = activeSession?.id === session.id;
              const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
              const laneColor = laneColorById.get(session.laneId) ?? null;
              const awaiting = isSessionAwaitingInput(session);
              const dropEdge = dragState
                && dragState.laneId === session.laneId
                && dragState.overIndex === index
                && dragState.sessionId !== session.id
                ? dragState.overEdge
                : null;
              return (
                <WorkTab
                  key={session.id}
                  session={session}
                  isActive={isActive}
                  isBusy={isBusy}
                  laneColor={laneColor}
                  awaiting={awaiting}
                  dropEdge={dropEdge}
                  onSelect={() => onSelectItem(session.id)}
                  onClose={() => onCloseItem(session.id)}
                  onContextMenu={(e) => handleContextMenu(session, e)}
                  dragProps={buildLaneDragProps({ laneId: session.laneId, sessionId: session.id, index })}
                />
              );
            })}
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
                style={{
                  width: 24,
                  height: 24,
                  marginLeft: 4,
                  cursor: "pointer",
                }}
                onClick={() => onShowDraftKind("chat")}
                aria-label="Start a new chat"
              >
                <Plus size={11} weight="bold" />
              </button>
            </SmartTooltip>
            </div>
          </div>
          <WorkSidebarToggle open={workSidebarOpen} onToggle={onToggleWorkSidebar} />
        </div>

        {tabBody}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        className={cn(
          "ade-work-glass-header flex w-full min-w-0 max-w-full shrink-0 items-start gap-1.5 px-2 py-2",
          workEmbeddedChrome?.dragHandleProps?.draggable && "cursor-grab active:cursor-grabbing"
        )}
        style={{ minHeight: 40 }}
        {...glassHeaderDragProps}
      >
        <SessionsPaneExpandAffordance {...expandSessionsProps} />
        <WorkPaneEmbeddedChromeLeading chrome={workEmbeddedChrome} />
        <div className="shrink-0 mt-0.5">
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        </div>
        <div className="ade-work-tab-strip-scroll min-w-0 flex-1 self-stretch overflow-x-auto overflow-y-hidden">
          <div className="flex min-w-0 w-max flex-row items-end gap-3 py-1">
            {resolvedTabGroups.map((group) => {
              const hasActive = group.sessionIds.includes(activeSession?.id ?? "");
              const isLaneGroup = group.kind === "lane";
              const laneId = isLaneGroup && group.id.startsWith("lane:") ? group.id.slice("lane:".length) : null;
              const laneColor = group.laneColor;
              const someAwaiting = group.sessions.some(isSessionAwaitingInput);
              const bandColor = laneColor?.trim() || null;
              const bandTint = bandColor
                ? laneSurfaceTint(bandColor, "default", 0.08)
                : laneSurfaceTint(null);
              const bandCssVars = {
                "--lane-band-color": bandColor ?? "color-mix(in srgb, var(--color-fg) 28%, transparent)",
                "--lane-band-bg": bandTint.background,
                "--lane-band-header-bg": bandColor
                  ? `color-mix(in srgb, ${bandColor} 12%, transparent)`
                  : "transparent",
              } as React.CSSProperties;
              const GroupIcon = isLaneGroup ? GitBranch : Funnel;
              if (group.collapsed) {
                return (
                  <SmartTooltip
                    key={group.id}
                    content={{
                      label: `Expand ${group.label}`,
                      description: "Show the work tabs in this group.",
                      effect: `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} in this group.`,
                    }}
                  >
                    <button
                      type="button"
                      aria-expanded={false}
                      aria-controls={`tab-group-${group.id}`}
                      className={cn(
                        "ade-work-lane-band ade-work-lane-band--collapsed",
                        someAwaiting && "ade-work-lane-band--awaiting",
                        hasActive && "ade-work-lane-band--active",
                      )}
                      style={bandCssVars}
                      onClick={() => toggleTabGroupCollapsed(group.id)}
                    >
                      <GroupIcon size={16} weight="regular" />
                      <span className="ade-work-lane-band-collapsed-label">
                        {group.label}
                      </span>
                      <span className="ade-work-lane-band-collapsed-count tabular-nums">
                        {group.sessions.length}
                      </span>
                    </button>
                  </SmartTooltip>
                );
              }
              return (
                <div
                  key={group.id}
                  className="ade-work-lane-band"
                  style={bandCssVars}
                >
                  <SmartTooltip
                    content={{
                      label: `Collapse ${group.label}`,
                      description: "Hide the work tabs in this group.",
                      effect: `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} in this group.`,
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded
                      aria-controls={`tab-group-${group.id}`}
                      className={cn(
                        "ade-work-lane-band-header",
                        hasActive && "text-fg",
                      )}
                      onClick={() => toggleTabGroupCollapsed(group.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleTabGroupCollapsed(group.id);
                        }
                      }}
                    >
                      <span className="max-w-[220px] truncate">
                        {group.label}
                      </span>
                      <span className="tabular-nums opacity-55">
                        {group.sessions.length}
                      </span>
                      <span className="inline-flex items-center opacity-55">
                        <CaretDown size={9} weight="bold" />
                      </span>
                    </div>
                  </SmartTooltip>
                  <div
                    id={`tab-group-${group.id}`}
                    role="tablist"
                    className="ade-work-lane-band-tabs"
                  >
                      {group.sessions.map((session, index) => {
                        const isActive = activeSession?.id === session.id;
                        const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                        const awaiting = isSessionAwaitingInput(session);
                        const dropEdge = dragState
                          && laneId
                          && dragState.laneId === laneId
                          && dragState.overIndex === index
                          && dragState.sessionId !== session.id
                          ? dragState.overEdge
                          : null;
                        return (
                          <WorkTab
                            key={session.id}
                            session={session}
                            isActive={isActive}
                            isBusy={isBusy}
                            laneColor={laneColor}
                            grouped
                            awaiting={awaiting}
                            dropEdge={dropEdge}
                            onSelect={() => onSelectItem(session.id)}
                            onClose={() => onCloseItem(session.id)}
                            onContextMenu={(e) => handleContextMenu(session, e)}
                            dragProps={laneId ? buildLaneDragProps({ laneId, sessionId: session.id, index }) : undefined}
                          />
                        );
                      })}
                  </div>
                </div>
              );
            })}
            <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  marginLeft: 4,
                  cursor: "pointer",
                }}
                onClick={() => onShowDraftKind("chat")}
                aria-label="Start a new chat"
              >
                <Plus size={12} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </div>
        <WorkSidebarToggle open={workSidebarOpen} onToggle={onToggleWorkSidebar} />
      </div>

      {tabBody}
    </div>
  );
}

const TILING_PRESET_OPTIONS: ReadonlyArray<{
  preset: TilingPreset;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  { preset: "auto", label: "Auto", description: "Balanced grid (default).", icon: <GridFour size={11} /> },
  { preset: "rows", label: "Rows", description: "Stack vertically, one full-width row per session.", icon: <Rows size={11} /> },
  { preset: "columns", label: "Columns", description: "Side by side, one full-height column per session.", icon: <Columns size={11} /> },
];

function ArrangeMenu({
  preset,
  onSelect,
}: {
  preset: TilingPreset;
  onSelect: (preset: TilingPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = TILING_PRESET_OPTIONS.find((opt) => opt.preset === preset) ?? TILING_PRESET_OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="flex max-w-full min-w-0 shrink-0 items-center gap-1"
    >
      <SmartTooltip content={{ label: "Arrange grid layout", description: "Pick a preset shape for the grid: Auto, Rows, or Columns." }}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="ade-liquid-glass-pill inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-all"
          style={{
            color: "var(--color-muted-fg)",
            border: "none",
            cursor: "pointer",
          }}
          title="Arrange grid layout"
        >
          {active.icon}
          {active.label}
          <CaretDown size={9} />
        </button>
      </SmartTooltip>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="arrange-menu"
            role="menu"
            initial={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            animate={{ clipPath: "inset(0 0% 0 0)", opacity: 1 }}
            exit={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="ade-liquid-glass-pill z-50 flex min-w-0 max-w-[min(100vw-24px,32rem)] flex-none flex-row flex-nowrap items-stretch divide-x divide-white/10 overflow-hidden rounded-md py-0.5"
          >
            <div className="flex min-w-0 flex-row flex-nowrap items-stretch overflow-x-auto scrollbar-none">
              {TILING_PRESET_OPTIONS.map((opt) => {
                const isActive = opt.preset === preset;
                return (
                  <button
                    key={opt.preset}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      onSelect(opt.preset);
                      setOpen(false);
                    }}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] transition-colors"
                    style={{
                      background: "transparent",
                      color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    title={opt.description}
                  >
                    <span className="inline-flex shrink-0 items-center justify-center">{opt.icon}</span>
                    <span className="shrink-0">{opt.label}</span>
                    <span className="inline-flex w-3 shrink-0 items-center justify-center">
                      {isActive ? <Check size={11} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: WorkViewMode;
  setViewMode: (mode: WorkViewMode) => void;
}) {
  return (
    <div
      className="ade-liquid-glass-pill inline-flex items-center rounded-full p-0.5"
      style={{
        height: 24,
      }}
    >
      {([
        { mode: "tabs" as const, icon: <List size={11} />, label: "Tabs", title: "Tab View", description: "Display sessions as tabs in a single panel." },
        { mode: "grid" as const, icon: <GridFour size={11} />, label: "Grid", title: "Grid View", description: "Display sessions side by side in a tiled grid." },
      ]).map(({ mode, icon, label, title, description }) => {
        const active = viewMode === mode;
        return (
          <SmartTooltip key={mode} content={{ label: title, description }}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => setViewMode(mode)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 text-[10px] font-medium transition-all${active ? " ade-work-tab-active" : ""}`}
              style={{
                height: 20,
                background: active ? undefined : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                border: "none",
                cursor: "pointer",
              }}
              title={title}
            >
              {icon}
              {label}
            </button>
          </SmartTooltip>
        );
      })}
    </div>
  );
}
