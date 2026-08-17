import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  CircleNotch,
  DownloadSimple,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import type { OpenProjectBinding } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { DraftMachinePicker } from "../../chat/DraftMachinePicker";
import { ToolLogo } from "../ToolLogos";
import { LaneCombobox, type LaneComboboxLane } from "../LaneCombobox";
import {
  ALL_IMPORT_PROVIDERS,
  getExternalSessionsApi,
  normalizeListResult,
  providerDisplayName,
  PROVIDER_FAMILY,
  PROVIDER_TOOL_TYPE,
  type ExternalSessionDetail,
  type ExternalSessionImportResult,
  type ExternalSessionProvider,
  type ExternalSessionSource,
  type ExternalSessionSummary,
} from "./contract";
import {
  importAffordancesFor,
  shortenCwd,
  type ImportAffordance,
} from "./affordances";
import { formatUpdatedAt, sessionDateGroup, sessionHeading } from "./sessionPresentation";

const PROVIDER_FILTERS: Array<{ id: ExternalSessionProvider | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "droid", label: "Droid" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

type ProviderFilter = ExternalSessionProvider | "all";

type ImportedSessionRef = { kind: "chat" | "cli"; sessionId: string };

function readImportedSessionRef(summary: ExternalSessionSummary): ImportedSessionRef | null {
  const raw = (summary as { importedSessionRef?: unknown }).importedSessionRef;
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  const sessionId = (raw as { sessionId?: unknown }).sessionId;
  if ((kind !== "chat" && kind !== "cli") || typeof sessionId !== "string" || !sessionId) {
    return null;
  }
  return { kind, sessionId };
}

const BROWSE_LIMIT = 200;
/** Must stay resolvable through the shared model registry; see the guard test. */
export const DEFAULT_FORK_MODEL = "anthropic/claude-sonnet-5";

function mergeSessions(
  prev: ExternalSessionSummary[],
  rows: ExternalSessionSummary[],
): ExternalSessionSummary[] {
  const byKey = new Map(prev.map((s) => [`${s.provider}:${s.id}`, s]));
  for (const row of rows) byKey.set(`${row.provider}:${row.id}`, row);
  return Array.from(byKey.values());
}

function hasPrompts(summary: ExternalSessionSummary): boolean {
  return summary.messageCount == null || summary.messageCount > 0;
}

function externalSessionScanFailureMessage(
  providers: readonly ExternalSessionProvider[],
  machineName: string,
): string {
  const source = providers.length === 1
    ? providerDisplayName(providers[0]) + " chats"
    : "external chats";
  return `ADE couldn't scan ${source} on ${machineName}. Check that this computer has the project open, then try again.`;
}

function ScrollPort({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-scroll-lock-scrollable=""
      onWheel={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export type ImportSessionBrowserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  laneId: string;
  laneName: string;
  lanes?: LaneComboboxLane[];
  sources?: ExternalSessionSource[];
  onImported: (
    summary: ExternalSessionSummary,
    result: ExternalSessionImportResult,
    source?: ExternalSessionSource,
  ) => void;
  onOpenExisting?: (ref: ImportedSessionRef, source?: ExternalSessionSource) => void;
};

export function ImportSessionBrowser({
  open,
  onOpenChange,
  laneId,
  laneName,
  lanes = [],
  sources,
  onImported,
  onOpenExisting,
}: ImportSessionBrowserProps) {
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [pendingProviders, setPendingProviders] = useState<ExternalSessionProvider[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerNotices, setProviderNotices] = useState<Partial<Record<ExternalSessionProvider, string>>>({});
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedSession, setSelectedSession] = useState<ExternalSessionSummary | null>(null);
  const fallbackLanes = useMemo<LaneComboboxLane[]>(
    () => lanes.length ? lanes : [{ id: laneId, name: laneName }],
    [laneId, laneName, lanes],
  );
  const fallbackSource = useMemo<ExternalSessionSource>(
    () => ({
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      lanes: fallbackLanes,
      binding: null,
      runtimePin: null,
      online: true,
    }),
    [fallbackLanes],
  );
  const sourceOptions = useMemo<ExternalSessionSource[]>(
    () => sources?.length ? sources : [fallbackSource],
    [fallbackSource, sources],
  );
  const defaultSource = sourceOptions.find((source) => source.machineId === THIS_MACHINE_ID)
    ?? sourceOptions[0]
    ?? null;
  const defaultSourceId = defaultSource?.machineId ?? null;
  const defaultLane = defaultSource?.lanes.find((lane) => lane.id === laneId)
    ?? defaultSource?.lanes.find((lane) => lane.laneType === "primary")
    ?? defaultSource?.lanes.find((lane) => lane.name.trim().toLowerCase() === "primary")
    ?? defaultSource?.lanes[0]
    ?? null;
  const defaultLaneId = defaultLane?.id ?? laneId;
  const [selectedSourceId, setSelectedSourceId] = useState(defaultSourceId);
  const [sourceSelectionTouched, setSourceSelectionTouched] = useState(false);
  const [targetLaneId, setTargetLaneId] = useState(defaultLaneId);
  const requestSeq = useRef(0);
  const selectedSource = sourceOptions.find((source) => source.machineId === selectedSourceId)
    ?? defaultSource;

  const availableLanes = useMemo<LaneComboboxLane[]>(
    () => selectedSource?.lanes.length ? selectedSource.lanes : fallbackLanes,
    [fallbackLanes, selectedSource],
  );
  const targetLaneName = availableLanes.find((lane) => lane.id === targetLaneId)?.name ?? targetLaneId;
  const loading = pendingProviders.length > 0;

  // Closing the dialog always returns the next open to the local computer. A
  // deliberate choice remains in force for the current browse, but it should
  // never become a surprising default the next time the importer opens.
  useEffect(() => {
    if (open) return;
    setSelectedSourceId((current) => current === defaultSourceId ? current : defaultSourceId);
    setSourceSelectionTouched(false);
    setTargetLaneId((current) => current === defaultLaneId ? current : defaultLaneId);
  }, [defaultLaneId, defaultSourceId, open]);

  // A disconnected source can disappear from the live catalog while the
  // dialog is open. Fall back to the local source and its primary lane rather
  // than leaving a stale lane id driving the next scan.
  useEffect(() => {
    const sourceStillExists = selectedSourceId != null
      && sourceOptions.some((source) => source.machineId === selectedSourceId);
    const shouldUseDefault = !sourceStillExists
      || (!sourceSelectionTouched && selectedSourceId !== defaultSourceId);
    if (shouldUseDefault) {
      setSelectedSourceId((current) => current === defaultSourceId ? current : defaultSourceId);
      setSourceSelectionTouched(false);
      setTargetLaneId((current) => current === defaultLaneId ? current : defaultLaneId);
      return;
    }
    if (!availableLanes.some((lane) => lane.id === targetLaneId)) {
      setTargetLaneId(defaultLaneId);
    }
  }, [availableLanes, defaultLaneId, defaultSourceId, selectedSourceId, sourceOptions, sourceSelectionTouched, targetLaneId]);

  const handleSourceChange = useCallback((nextSourceId: string) => {
    const nextSource = sourceOptions.find((source) => source.machineId === nextSourceId);
    if (!nextSource || !nextSource.online) return;
    const nextLane = nextSource.lanes.find((lane) => lane.laneType === "primary")
      ?? nextSource.lanes.find((lane) => lane.name.trim().toLowerCase() === "primary")
      ?? nextSource.lanes[0]
      ?? null;
    setSelectedSourceId(nextSourceId);
    setSourceSelectionTouched(true);
    setTargetLaneId(nextLane?.id ?? laneId);
    setSessions([]);
    setLoadError(null);
    setProviderNotices({});
    setImportError(null);
    setSelectedSession(null);
    setActiveIndex(0);
    setQuery("");
  }, [laneId, sourceOptions]);

  const load = useCallback(async () => {
    const api = getExternalSessionsApi();
    if (!api) {
      setLoadError("Importing sessions isn't available in this window.");
      setSessions([]);
      setPendingProviders([]);
      return;
    }
    const seq = ++requestSeq.current;
    const providers = providerFilter === "all" ? ALL_IMPORT_PROVIDERS : [providerFilter];
    setSessions([]);
    setLoadError(null);
    setProviderNotices({});
    setPendingProviders(providers);
    let failures = 0;
    const runtimePin = selectedSource?.runtimePin ?? null;
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const request = {
            providers: [provider],
            scope: "project" as const,
            laneId: targetLaneId,
            limit: BROWSE_LIMIT,
          };
          const result = runtimePin
            ? await api.list(request, runtimePin)
            : await api.list(request);
          if (seq !== requestSeq.current) return;
          const rows = normalizeListResult(result).filter(hasPrompts);
          setSessions((prev) => mergeSessions(prev, rows));
          setSelectedSession((current) => {
            if (!current) return null;
            return rows.find((row) => row.provider === current.provider && row.id === current.id) ?? current;
          });
        } catch {
          if (seq !== requestSeq.current) return;
          failures += 1;
          setProviderNotices((prev) => ({
            ...prev,
            [provider]: `${providerDisplayName(provider)} couldn't be scanned on ${selectedSource?.machineName ?? THIS_MACHINE_NAME}.`,
          }));
        } finally {
          if (seq === requestSeq.current) {
            setPendingProviders((prev) => prev.filter((p) => p !== provider));
          }
        }
      }),
    );
    if (seq !== requestSeq.current) return;
    if (failures === providers.length) {
      setLoadError(externalSessionScanFailureMessage(
        providers,
        selectedSource?.machineName ?? THIS_MACHINE_NAME,
      ));
    }
  }, [providerFilter, selectedSource?.machineName, selectedSource?.runtimePin, targetLaneId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    setImporting(null);
    setImportError(null);
    setActiveIndex(0);
    setSelectedSession(null);
    setTargetLaneId(defaultLaneId);
  }, [defaultLaneId, laneId, open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter(hasPrompts)
      .filter((s) => (providerFilter === "all" ? true : s.provider === providerFilter))
      .filter((s) =>
        q
          ? [s.title, s.preview, s.cwd, s.id, ...(s.messages ?? []).map((m) => m.text)]
              .some((value) => value?.toLowerCase().includes(q))
          : true,
      )
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sessions, providerFilter, query]);

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; rows: ExternalSessionSummary[] }> = [];
    for (const summary of visible) {
      const label = sessionDateGroup(summary.updatedAt);
      const last = groups.at(-1);
      if (last?.label === label) last.rows.push(summary);
      else groups.push({ label, rows: [summary] });
    }
    return groups;
  }, [visible]);

  useEffect(() => {
    setActiveIndex((idx) => Math.min(idx, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const noticeText = useMemo(() => {
    const messages = Object.values(providerNotices).filter((message): message is string => Boolean(message));
    return messages.length ? messages.join(" ") : null;
  }, [providerNotices]);

  const runImport = useCallback(
    async (summary: ExternalSessionSummary, affordance: ImportAffordance, model?: string) => {
      if (!affordance.enabled || importing || loading) return;
      const api = getExternalSessionsApi();
      if (!api) {
        setImportError("Importing sessions isn't available in this window.");
        return;
      }
      const key = `${summary.id}:${affordance.kind}`;
      setImporting(key);
      setImportError(null);
      try {
        const request = {
          provider: summary.provider,
          sessionId: summary.id,
          laneId: targetLaneId,
          target: affordance.target,
          mode: affordance.mode,
          ...(model ? { model } : {}),
        };
        const runtimePin = selectedSource?.runtimePin ?? null;
        const result = runtimePin
          ? await api.import(request, runtimePin)
          : await api.import(request);
        onImported(summary, result, selectedSource ?? undefined);
        onOpenChange(false);
      } catch {
        setImportError(`Couldn't ${affordance.label.toLowerCase()} on ${selectedSource?.machineName ?? THIS_MACHINE_NAME}.`);
      } finally {
        setImporting(null);
      }
    },
    [importing, loading, onImported, onOpenChange, selectedSource, targetLaneId],
  );

  const handleOpenExisting = useCallback(
    (ref: ImportedSessionRef) => {
      onOpenExisting?.(ref, selectedSource ?? undefined);
      onOpenChange(false);
    },
    [onOpenExisting, onOpenChange, selectedSource],
  );

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,button,select,textarea,[role='combobox']")) return;
      if (selectedSession) return;
      if (!visible.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((idx) => Math.min(idx + 1, visible.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((idx) => Math.max(idx - 1, 0));
      } else if (event.key === "Enter") {
        const summary = visible[activeIndex];
        if (!summary) return;
        event.preventDefault();
        const importedRef = readImportedSessionRef(summary);
        if (summary.alreadyImported && importedRef && onOpenExisting) {
          handleOpenExisting(importedRef);
          return;
        }
        setSelectedSession(summary);
      }
    },
    [activeIndex, handleOpenExisting, onOpenExisting, selectedSession, visible],
  );

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Import session"
      icon={DownloadSimple}
      widthClassName="w-[min(980px,calc(100vw-4rem))]"
      heightClassName="h-[min(860px,calc(100dvh-4rem))]"
      scrollBody={false}
      busy={Boolean(importing)}
    >
      <div className="flex h-full min-h-0 flex-col gap-3" onKeyDown={onListKeyDown}>
        {!selectedSession ? <div className="flex shrink-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {PROVIDER_FILTERS.map((filter) => {
              const selected = providerFilter === filter.id;
              const isAll = filter.id === "all";
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setProviderFilter(filter.id)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border text-[11px] font-medium transition-colors",
                    isAll ? "px-3" : "pl-2 pr-3",
                    selected
                      ? "border-white/[0.14] bg-white/[0.08] text-fg"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/80 hover:text-fg",
                  )}
                >
                  {filter.id !== "all" ? (
                    <ToolLogo
                      toolType={PROVIDER_TOOL_TYPE[filter.id]}
                      size={18}
                      className={cn("transition-opacity", selected ? "opacity-100" : "opacity-75")}
                    />
                  ) : null}
                  {filter.label}
                </button>
              );
            })}
            <DraftMachinePicker
              machines={sourceOptions.map((source) => ({
                id: source.machineId,
                name: source.machineName,
                unavailableReason: source.online
                  ? null
                  : "This computer is offline. Reconnect it to scan chats.",
              }))}
              selectedMachineId={selectedSourceId}
              onChange={handleSourceChange}
              disabled={Boolean(importing)}
              tooltipLabel="Import from"
              triggerLabel="Choose import source"
              tooltipDescription="Choose which connected computer to scan. The session list and import actions follow this computer."
            />
            <div className="ml-auto flex items-center gap-2">
              {loading && sessions.length ? (
                <span className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-fg/60">
                  <CircleNotch size={11} className="animate-spin" />
                  Scanning {pendingProviders.map(providerDisplayName).join(", ")}…
                </span>
              ) : null}
              <SmartTooltip content={{ label: "Refresh", description: "Re-scan chats from outside ADE." }}>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-muted-fg/80 transition-colors hover:text-fg disabled:opacity-50"
                  aria-label="Refresh session list"
                >
                  {loading ? <CircleNotch size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
                </button>
              </SmartTooltip>
            </div>
          </div>
          <div className="relative">
            <MagnifyingGlass
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/60"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions"
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] pl-8 pr-3 text-[12px] text-fg placeholder:text-muted-fg/50 focus:border-white/[0.14] focus:outline-none"
            />
          </div>
        </div> : null}

        {!selectedSession && noticeText && !loadError ? (
          <div className="flex shrink-0 items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-muted-fg/70">
            <Warning size={13} className="mt-px shrink-0 text-muted-fg/60" />
            <span>{noticeText}</span>
          </div>
        ) : null}

        {importError ? (
          <div className="flex shrink-0 items-start gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
            <Warning size={14} className="mt-px shrink-0" />
            <span>{importError}</span>
          </div>
        ) : null}

        {selectedSession ? (
          <ImportSessionDetail
            summary={selectedSession}
            lanes={availableLanes}
            targetLaneId={targetLaneId}
            targetLaneName={targetLaneName}
            importingKey={importing}
            refreshing={loading}
            onBack={() => setSelectedSession(null)}
            onTargetLaneChange={setTargetLaneId}
            onImport={(affordance, model) => void runImport(selectedSession, affordance, model)}
            onOpenExisting={onOpenExisting ? handleOpenExisting : undefined}
            runtimePin={selectedSource?.runtimePin ?? null}
          />
        ) : loading && !sessions.length ? (
          <ScrollPort>
            <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-8 text-center">
              <div
                className="inline-flex items-center gap-2 text-[12px] font-medium text-fg"
                role="status"
                aria-live="polite"
              >
                <CircleNotch size={16} className="animate-spin text-violet-300" />
                Scanning external chats…
              </div>
              <p className="max-w-sm text-[11px] leading-relaxed text-muted-fg/65">
                Checking {pendingProviders.map(providerDisplayName).join(", ")} on {selectedSource?.machineName ?? THIS_MACHINE_NAME}.
              </p>
              <ul className="w-full max-w-2xl space-y-2 opacity-60" aria-hidden="true">
                {Array.from({ length: 3 }, (_, index) => (
                  <li key={index} className="h-[62px] animate-pulse rounded-xl border border-white/[0.05] bg-white/[0.03]" />
                ))}
              </ul>
            </div>
          </ScrollPort>
        ) : loadError ? (
          <CenterState
            icon={<Warning size={18} className="text-amber-400" />}
            title="External chats couldn't be loaded"
            detail={loadError}
            action={
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.1] px-3 text-[11px] text-fg hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowClockwise size={12} className={loading ? "animate-spin" : undefined} /> Retry scan
              </button>
            }
          />
        ) : !visible.length ? (
          <CenterState
            icon={<DownloadSimple size={18} className="text-muted-fg/60" />}
            title="No chats found"
            detail="No Claude, Codex, Cursor, Droid, OpenCode, or Pi chats in this project."
          />
        ) : (
          <ScrollPort>
            <div className="flex flex-col gap-4">
              {grouped.map((group) => (
                <section key={group.label}>
                  <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg/55">
                    {group.label}
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {group.rows.map((summary) => {
                      const index = visible.indexOf(summary);
                      return (
                        <ImportSessionRow
                          key={`${summary.provider}:${summary.id}`}
                          summary={summary}
                          active={index === activeIndex}
                          onActivate={() => setActiveIndex(index)}
                          onSelect={() => setSelectedSession(summary)}
                        />
                      );
                    })}
                  </ul>
                </section>
              ))}
              {loading ? (
                <ul className="flex flex-col gap-2">
                  {Array.from({ length: 2 }, (_, index) => (
                    <li key={`sk-${index}`} className="h-[72px] animate-pulse rounded-xl border border-white/[0.05] bg-white/[0.03]" />
                  ))}
                </ul>
              ) : null}
            </div>
          </ScrollPort>
        )}
      </div>
    </LaneDialogShell>
  );
}

function CenterState({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-2 text-muted-fg">{icon}</div>
      <div className="text-[12px] font-medium text-fg">{title}</div>
      {detail ? <div className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted-fg/70">{detail}</div> : null}
      {action}
    </div>
  );
}

function ImportSessionRow({
  summary,
  active,
  onActivate,
  onSelect,
}: {
  summary: ExternalSessionSummary;
  active: boolean;
  onActivate: () => void;
  onSelect: () => void;
}) {
  const heading = sessionHeading(summary);

  return (
    <li
      onMouseEnter={onActivate}
      className={cn(
        "group rounded-xl border px-4 py-3 transition-colors",
        active
          ? "border-white/[0.14] bg-white/[0.05]"
          : "border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.035]",
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <ToolLogo toolType={PROVIDER_TOOL_TYPE[summary.provider]} size={22} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-fg">{heading}</span>
            {summary.alreadyImported ? (
              <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-fg/80">
                Imported
              </span>
            ) : null}
            {summary.possiblyActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-500/[0.1] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.9)]" />
                Live
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-fg/70">
            {formatUpdatedAt(summary.updatedAt) ? <span>{formatUpdatedAt(summary.updatedAt)}</span> : null}
            {summary.messageCount != null ? (
              <>
                <span className="text-muted-fg/40">·</span>
                <span>
                  {summary.messageCount} prompt{summary.messageCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
            {summary.cwd ? (
              <span
                className="ml-0.5 max-w-[240px] truncate rounded border border-white/[0.05] bg-white/[0.03] px-1.5 py-px font-mono text-[9.5px] text-muted-fg/60"
                title={summary.cwd}
              >
                {shortenCwd(summary.cwd, 2)}
              </span>
            ) : null}
          </div>
        </div>
        <span className="mt-0.5 shrink-0 rounded-full border border-white/[0.1] bg-white/[0.06] px-2.5 py-1 text-[10.5px] font-medium text-fg/85 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          Show details
        </span>
      </button>
    </li>
  );
}

function ImportSessionDetail({
  summary,
  lanes,
  targetLaneId,
  targetLaneName,
  importingKey,
  refreshing,
  onBack,
  onTargetLaneChange,
  onImport,
  onOpenExisting,
  runtimePin,
}: {
  summary: ExternalSessionSummary;
  lanes: LaneComboboxLane[];
  targetLaneId: string;
  targetLaneName: string;
  importingKey: string | null;
  refreshing: boolean;
  onBack: () => void;
  onTargetLaneChange: (laneId: string) => void;
  onImport: (affordance: ImportAffordance, model?: string) => void;
  onOpenExisting?: (ref: ImportedSessionRef) => void;
  runtimePin: OpenProjectBinding | null;
}) {
  const importedRef = summary.alreadyImported ? readImportedSessionRef(summary) : null;
  const allAffordances = importAffordancesFor(summary);
  const available = allAffordances
    .filter((action) => action.enabled)
    .filter((action) => !importedRef || action.mode === "fork")
    .sort((left, right) => {
      if (!summary.possiblyActive || left.mode === right.mode) return 0;
      return left.mode === "fork" ? -1 : 1;
    });
  const unavailable = allAffordances.filter((action) => !action.enabled);
  const heading = sessionHeading(summary);
  const [detail, setDetail] = useState<ExternalSessionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // The recorded launch model is whatever the foreign CLI wrote down, so it only
  // seeds the picker when the shared registry can actually resolve it — an
  // unresolvable id would leave the fork with no family and no descriptor.
  const [forkModel, setForkModel] = useState(() => {
    const recorded = summary.launch?.model?.trim();
    return recorded && resolveModelDescriptor(recorded) ? recorded : DEFAULT_FORK_MODEL;
  });

  useEffect(() => {
    const api = getExternalSessionsApi();
    if (!api) return;
    const watchId = `${summary.provider}:${summary.id}`;
    let cancelled = false;
    const apply = (next: ExternalSessionDetail) => {
      if (!cancelled) setDetail(next);
    };
    setDetailError(null);
    const localWatch = runtimePin?.kind !== "remote" && api.watchDetail ? api.watchDetail : null;
    void (async () => {
      try {
        const loaded = localWatch
          ? await localWatch({ provider: summary.provider, sessionId: summary.id, watchId })
          : await api.getDetail?.(
            { provider: summary.provider, sessionId: summary.id },
            runtimePin,
          );
        if (loaded) apply(loaded);
      } catch {
        if (!cancelled) {
          setDetailError("Couldn't load this conversation from the selected computer.");
        }
      }
    })();
    const unsubscribe = localWatch
      ? api.onDetailUpdated?.((event) => {
        if (event.watchId === watchId) apply(event.detail);
      })
      : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (localWatch) void api.unwatchDetail?.({ watchId });
    };
  }, [runtimePin, summary.id, summary.provider]);

  const messages = detail?.messages?.length ? detail.messages : (summary.messages ?? []);
  const modelLabel = detail?.model ?? summary.launch?.model ?? null;
  const forkFamily = resolveModelDescriptor(forkModel)?.family ?? null;
  const sourceFamily = PROVIDER_FAMILY[summary.provider];
  const crossFamily = Boolean(forkFamily && forkFamily !== sourceFamily);

  const choose = (affordance: ImportAffordance) => {
    if (
      summary.possiblyActive
      && affordance.mode === "resume"
      && !window.confirm("This chat is live in another app. Close it there before continuing here, or make a copy instead. Continue anyway?")
    ) {
      return;
    }
    onImport(affordance, affordance.kind === "fork-as-chat" ? forkModel : undefined);
  };

  return (
    <ScrollPort>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
      >
        <ArrowLeft size={13} /> All sessions
      </button>

      <section className="flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
        <div className="shrink-0 border-b border-white/[0.06] p-4">
          <div className="flex items-start gap-3">
            <ToolLogo toolType={PROVIDER_TOOL_TYPE[summary.provider]} size={28} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[16px] font-semibold text-fg">{heading}</h3>
                {summary.alreadyImported ? (
                  <span className="rounded-full bg-emerald-500/[0.1] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">In ADE</span>
                ) : null}
                {summary.possiblyActive ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.12] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-200">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Live
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-fg/70">
                <span>{providerDisplayName(summary.provider)}</span>
                {formatUpdatedAt(summary.updatedAt) ? <span>· {formatUpdatedAt(summary.updatedAt)}</span> : null}
                {summary.messageCount != null ? (
                  <span>· {summary.messageCount} prompt{summary.messageCount === 1 ? "" : "s"}</span>
                ) : null}
                {modelLabel ? <span>· {modelLabel}</span> : null}
              </div>
            </div>
          </div>
        </div>
        <div
          className="px-4 py-3"
          role="region"
          aria-label="Session conversation"
        >
          {detailError ? (
            <p className="text-[11px] text-amber-200/80">{detailError}</p>
          ) : !detail && !messages.length ? (
            <div className="flex flex-col gap-2">
              <div className="h-10 animate-pulse rounded-2xl bg-white/[0.04]" />
              <div className="ml-auto h-10 w-2/3 animate-pulse rounded-2xl bg-white/[0.06]" />
            </div>
          ) : messages.length ? (
            <div className="flex flex-col gap-2">
              {messages.map((message, index) => (
                <div
                  key={`${message.at ?? index}-${index}`}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[12px] leading-relaxed",
                      message.role === "user"
                        ? "rounded-br-md bg-violet-500/20 text-fg"
                        : "rounded-bl-md bg-white/[0.05] text-fg/85",
                    )}
                  >
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-fg/60">No conversation preview was recoverable for this chat.</p>
          )}
        </div>
        <dl className="grid shrink-0 gap-2 border-t border-white/[0.06] px-4 py-3 text-[10.5px] sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-fg/50">Folder</dt>
            <dd className="truncate text-left font-mono text-muted-fg/80" dir="rtl" title={summary.cwd ?? undefined}>
              <bdi dir="ltr">{shortenCwd(detail?.cwd ?? summary.cwd, 5)}</bdi>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-fg/50">Session</dt>
            <dd className="truncate font-mono text-muted-fg/80" title={summary.id}>{summary.id}</dd>
          </div>
        </dl>
      </section>

      <section className="shrink-0 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-fg">Import into</div>
            <div className="mt-0.5 text-[10.5px] text-muted-fg/65">Actions update to match the selected lane.</div>
          </div>
          <LaneCombobox
            lanes={lanes}
            value={targetLaneId}
            onChange={onTargetLaneChange}
            variant="pill"
            aria-label="Import into lane"
          />
        </div>
      </section>

      {importedRef && onOpenExisting ? (
        <section className="flex shrink-0 items-center justify-between gap-3 rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.04] p-4">
          <div>
            <div className="text-[12px] font-semibold text-fg">Already imported</div>
            <div className="mt-0.5 text-[10.5px] text-muted-fg/70">
              Open the existing {importedRef.kind === "chat" ? "ADE chat" : "CLI session"}, or create another copy below.
            </div>
          </div>
          <button type="button" onClick={() => onOpenExisting(importedRef)} className="shrink-0 rounded-full bg-emerald-300 px-4 py-2 text-[11px] font-semibold text-[#0F0D14]">Open existing</button>
        </section>
      ) : null}

      <section className="shrink-0">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-fg">
          Choose an action for {targetLaneName}
          {refreshing ? <CircleNotch size={12} className="animate-spin text-muted-fg" /> : null}
        </div>
        {summary.possiblyActive ? (
          <div className="mb-3 flex gap-2 rounded-xl border border-amber-400/15 bg-amber-500/[0.04] px-3 py-2 text-[10.5px] leading-relaxed text-amber-200/80">
            <Warning size={13} className="mt-px shrink-0" /> This chat is live elsewhere. A copy is the safer option.
          </div>
        ) : null}
        {available.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {available.map((affordance) => {
              const busy = importingKey === `${summary.id}:${affordance.kind}`;
              const isForkChat = affordance.kind === "fork-as-chat";
              return (
                <div
                  key={affordance.kind}
                  className="rounded-xl border border-white/[0.09] bg-white/[0.025] p-4"
                >
                  <button
                    type="button"
                    disabled={Boolean(importingKey) || refreshing}
                    onClick={() => choose(affordance)}
                    className="w-full text-left transition-colors disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2 text-[12px] font-semibold text-fg">
                      {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
                      {affordance.label}
                    </div>
                    <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-fg/70">{affordance.description}</p>
                    {affordance.hint || affordance.foreignCwd ? (
                      <p className="mt-2 text-[10px] leading-relaxed text-violet-300/75">
                        {affordance.hint ?? `Runs in ${shortenCwd(affordance.foreignCwd, 5)}, not ${targetLaneName}.`}
                      </p>
                    ) : null}
                  </button>
                  {isForkChat ? (
                    <div className="mt-3 border-t border-white/[0.06] pt-3" onClick={(event) => event.stopPropagation()}>
                      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg/60">
                        Fork with model
                      </div>
                      <ModelPicker
                        value={forkModel}
                        onChange={(modelId) => setForkModel(modelId)}
                        surfaceKey="import-fork-as-chat"
                        compact
                      />
                      {crossFamily ? (
                        <p className="mt-2 text-[10px] leading-relaxed text-muted-fg/65">
                          Carries the conversation, not provider-internal state.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[11px] leading-relaxed text-muted-fg/70">
            This provider cannot safely continue or copy the session into {targetLaneName}. Choose the session's original lane or another provider-supported target.
          </div>
        )}
        {unavailable.map((action) => (
          <p key={action.kind} className="mt-2 text-[10px] text-muted-fg/55">{action.disabledReason}</p>
        ))}
      </section>
    </div>
    </ScrollPort>
  );
}
