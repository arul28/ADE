import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  CaretRight,
  CircleNotch,
  DownloadSimple,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ToolLogo } from "../ToolLogos";
import { LaneCombobox, type LaneComboboxLane } from "../LaneCombobox";
import {
  getExternalSessionsApi,
  normalizeListResult,
  providerDisplayName,
  PROVIDER_TOOL_TYPE,
  type ExternalSessionImportResult,
  type ExternalSessionProvider,
  type ExternalSessionSummary,
} from "./contract";
import {
  importAffordancesFor,
  shortenCwd,
  type ImportAffordance,
} from "./affordances";
import { formatUpdatedAt, sessionAnchors, sessionHeading } from "./sessionPresentation";

const PROVIDER_FILTERS: Array<{ id: ExternalSessionProvider | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "droid", label: "Droid" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

/** Every provider we scan when no specific filter is applied. */
const ALL_PROVIDERS: ExternalSessionProvider[] = ["claude", "codex", "cursor", "droid", "opencode", "pi"];

type ProviderFilter = ExternalSessionProvider | "all";

/**
 * Reference to an already-imported ADE session, populated by the backend on
 * summaries whose external session has been imported before. Read defensively:
 * the field is being added to {@link ExternalSessionSummary} concurrently and
 * may not be declared on the type yet.
 */
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

/**
 * The service scans 200 rows per provider when project-scoped; asking for the
 * default 50 threw most of that away, so a busy project's older sessions were
 * scanned and then dropped before they reached the pane.
 */
const BROWSE_LIMIT = 200;

/** Merge freshly-resolved rows into the running list, de-duped by provider+id. */
function mergeSessions(
  prev: ExternalSessionSummary[],
  rows: ExternalSessionSummary[],
): ExternalSessionSummary[] {
  const byKey = new Map(prev.map((s) => [`${s.provider}:${s.id}`, s]));
  for (const row of rows) byKey.set(`${row.provider}:${row.id}`, row);
  return Array.from(byKey.values());
}

export type ImportSessionBrowserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  laneId: string;
  laneName: string;
  lanes?: LaneComboboxLane[];
  onImported: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
  /** Navigate to an already-imported ADE session instead of re-importing it. */
  onOpenExisting?: (ref: ImportedSessionRef) => void;
};

export function ImportSessionBrowser({
  open,
  onOpenChange,
  laneId,
  laneName,
  lanes = [],
  onImported,
  onOpenExisting,
}: ImportSessionBrowserProps) {
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [pendingProviders, setPendingProviders] = useState<ExternalSessionProvider[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A provider that cannot run at all (OpenCode with no CLI installed) is not
  // the same as a provider with no sessions, and the empty list cannot say so.
  const [providerNotices, setProviderNotices] = useState<Partial<Record<ExternalSessionProvider, string>>>({});
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedSession, setSelectedSession] = useState<ExternalSessionSummary | null>(null);
  const [targetLaneId, setTargetLaneId] = useState(laneId);
  const requestSeq = useRef(0);

  const availableLanes = useMemo<LaneComboboxLane[]>(
    () => lanes.length ? lanes : [{ id: laneId, name: laneName }],
    [laneId, laneName, lanes],
  );
  const targetLaneName = availableLanes.find((lane) => lane.id === targetLaneId)?.name ?? targetLaneId;

  const scope: "project" | "all" = showAllFolders ? "all" : "project";
  const loading = pendingProviders.length > 0;

  // Progressive scan: fire one list() per provider in parallel and stream each
  // provider's rows into the list as it resolves, so results appear as they
  // come in instead of blocking on the slowest provider. A specific provider
  // filter narrows the scan to just that provider.
  const load = useCallback(async () => {
    const api = getExternalSessionsApi();
    if (!api) {
      setLoadError("Importing sessions isn't available in this window.");
      setSessions([]);
      setPendingProviders([]);
      return;
    }
    const seq = ++requestSeq.current;
    const providers = providerFilter === "all" ? ALL_PROVIDERS : [providerFilter];
    setSessions([]);
    setLoadError(null);
    setProviderNotices({});
    setPendingProviders(providers);
    let failures = 0;
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await api.list({ providers: [provider], scope, laneId: targetLaneId, limit: BROWSE_LIMIT });
          if (seq !== requestSeq.current) return;
          const rows = normalizeListResult(result);
          setSessions((prev) => mergeSessions(prev, rows));
          setSelectedSession((current) => {
            if (!current) return null;
            return rows.find((row) => row.provider === current.provider && row.id === current.id) ?? current;
          });
        } catch (error) {
          if (seq !== requestSeq.current) return;
          failures += 1;
          const detail = error instanceof Error ? error.message.trim() : "";
          setProviderNotices((prev) => ({
            ...prev,
            // The panel joins every provider's notice into one line, so a bare
            // provider error message would read as if it came from the scan as
            // a whole once a second provider fails too.
            [provider]: detail
              ? `${providerDisplayName(provider)}: ${detail}`
              : `${providerDisplayName(provider)} sessions couldn't be scanned.`,
          }));
        } finally {
          if (seq === requestSeq.current) {
            setPendingProviders((prev) => prev.filter((p) => p !== provider));
          }
        }
      }),
    );
    if (seq !== requestSeq.current) return;
    // Only surface a blocking error when the entire scan failed; a single
    // provider throwing shouldn't hide the others' results.
    if (failures === providers.length) {
      setLoadError("Couldn't load external sessions.");
    }
  }, [providerFilter, scope, targetLaneId]);

  // One-shot load whenever the browser opens or the scope changes; no polling.
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Reset transient state each time the browser is opened.
  useEffect(() => {
    if (!open) return;
    setImporting(null);
    setImportError(null);
    setActiveIndex(0);
    setSelectedSession(null);
    setTargetLaneId(laneId);
  }, [laneId, open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => (providerFilter === "all" ? true : s.provider === providerFilter))
      .filter((s) =>
        q
          // Search the whole thread sample, not just the title: the words you
          // remember from a conversation are usually in the conversation, and
          // provider titles are frequently absent entirely.
          ? [s.title, s.preview, s.cwd, s.id, ...(s.messages ?? []).map((m) => m.text)]
              .some((value) => value?.toLowerCase().includes(q))
          : true,
      )
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sessions, providerFilter, query]);

  useEffect(() => {
    setActiveIndex((idx) => Math.min(idx, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  // Suppressed while `loadError` is up: that state already explains the scan.
  const noticeText = useMemo(() => {
    if (loadError) return null;
    const messages = Object.values(providerNotices).filter((message): message is string => Boolean(message));
    return messages.length ? messages.join(" ") : null;
  }, [loadError, providerNotices]);

  const runImport = useCallback(
    async (summary: ExternalSessionSummary, affordance: ImportAffordance) => {
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
        const result = await api.import({
          provider: summary.provider,
          sessionId: summary.id,
          laneId: targetLaneId,
          target: affordance.target,
          mode: affordance.mode,
        });
        onImported(summary, result);
        onOpenChange(false);
      } catch (err) {
        setImportError(
          err instanceof Error ? err.message : `Couldn't ${affordance.label.toLowerCase()}.`,
        );
      } finally {
        setImporting(null);
      }
    },
    [importing, loading, onImported, onOpenChange, targetLaneId],
  );

  const handleOpenExisting = useCallback(
    (ref: ImportedSessionRef) => {
      onOpenExisting?.(ref);
      onOpenChange(false);
    },
    [onOpenExisting, onOpenChange],
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
      // Content-driven, not pinned: the details stage is far shorter than the
      // list stage, and a fixed height left ~400px of dead space under it.
      heightClassName="max-h-[min(860px,calc(100dvh-4rem))]"
      busy={Boolean(importing)}
    >
      <div className="flex h-full min-h-0 flex-col gap-3" onKeyDown={onListKeyDown}>
        {/* Browse filters */}
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
                      className={cn(
                        "transition-opacity",
                        selected ? "opacity-100" : "opacity-75",
                      )}
                    />
                  ) : null}
                  {filter.label}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-2">
              {loading && sessions.length ? (
                <span className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-fg/60">
                  <CircleNotch size={11} className="animate-spin" />
                  Scanning {pendingProviders.map(providerDisplayName).join(", ")}…
                </span>
              ) : null}
              <SmartTooltip content={{ label: "Refresh", description: "Re-scan external sessions." }}>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.02] text-muted-fg/80 transition-colors hover:text-fg disabled:opacity-50"
                  aria-label="Refresh session list"
                >
                  {loading ? (
                    <CircleNotch size={13} className="animate-spin" />
                  ) : (
                    <ArrowClockwise size={13} />
                  )}
                </button>
              </SmartTooltip>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
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
            <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-fg/80">
              <input
                type="checkbox"
                checked={showAllFolders}
                onChange={(e) => setShowAllFolders(e.target.checked)}
                className="h-3.5 w-3.5 accent-[#A78BFA]"
              />
              Show sessions from other folders
            </label>
          </div>
        </div> : null}

        {!selectedSession && noticeText ? (
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

        {/* Browse list / import review */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
              onImport={(affordance) => void runImport(selectedSession, affordance)}
              onOpenExisting={onOpenExisting ? handleOpenExisting : undefined}
            />
          ) : loading && !sessions.length ? (
            <CenterState icon={<CircleNotch size={18} className="animate-spin" />} title="Scanning sessions" />
          ) : loadError ? (
            <CenterState
              icon={<Warning size={18} className="text-amber-400" />}
              title="Couldn't load sessions"
              detail={loadError}
              action={
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.1] px-3 text-[11px] text-fg hover:bg-white/[0.05]"
                >
                  <ArrowClockwise size={12} /> Retry
                </button>
              }
            />
          ) : !visible.length ? (
            <CenterState
              icon={<DownloadSimple size={18} className="text-muted-fg/60" />}
              title="No external sessions found"
              detail={
                showAllFolders
                  ? "No Claude, Codex, Cursor, Droid, or OpenCode sessions on this machine."
                  : "No sessions from this project's folder. Try showing sessions from other folders."
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((summary, index) => (
                <ImportSessionRow
                  key={`${summary.provider}:${summary.id}`}
                  summary={summary}
                  active={index === activeIndex}
                  onActivate={() => setActiveIndex(index)}
                  onSelect={() => setSelectedSession(summary)}
                />
              ))}
            </ul>
          )}
        </div>
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
  const preview = summary.preview?.trim();
  const anchors = sessionAnchors(summary);

  return (
    <li
      onMouseEnter={onActivate}
      className={cn(
        "rounded-xl border px-4 py-3.5 transition-colors",
        active
          ? "border-white/[0.14] bg-white/[0.05]"
          : "border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.035]",
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <ToolLogo
          toolType={PROVIDER_TOOL_TYPE[summary.provider]}
          size={22}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-fg">{heading}</span>
            {summary.alreadyImported ? (
              <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-fg/80">
                Imported
              </span>
            ) : null}
            {summary.possiblyActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/20 bg-amber-500/[0.06] px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-amber-300/90">
                <Warning size={9} weight="fill" className="opacity-80" /> May be open elsewhere
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-fg/70">
            <span>{providerDisplayName(summary.provider)}</span>
            {formatUpdatedAt(summary.updatedAt) ? (
              <>
                <span className="text-muted-fg/40">·</span>
                <span>{formatUpdatedAt(summary.updatedAt)}</span>
              </>
            ) : null}
            {summary.messageCount != null ? (
              <>
                <span className="text-muted-fg/40">·</span>
                <span>
                  {summary.messageCount} prompt{summary.messageCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
            {summary.cwd ? (
              /* Shortened, not clipped: `truncate` drops the tail, and the
                 tail is the repo folder — the only part that tells two
                 sessions apart. Every Windows row read `C:\Users\…\Doc…`. */
              <span
                className="ml-0.5 max-w-[240px] truncate rounded border border-white/[0.05] bg-white/[0.03] px-1.5 py-px font-mono text-[9.5px] text-muted-fg/60"
                title={summary.cwd}
              >
                {shortenCwd(summary.cwd, 2)}
              </span>
            ) : null}
          </div>

          {anchors.started || anchors.latest ? (
            /*
              Two anchors beat one snippet: what the thread started as, and where
              it left off. Picking the right session out of a long list is almost
              always a question of "which task was this", which the opening ask
              answers, plus "how far did it get", which the last turn answers.
            */
            <div className="mt-2 flex flex-col gap-1 border-l border-white/[0.08] pl-2.5">
              {anchors.started ? (
                <p className="line-clamp-1 text-[10.5px] leading-relaxed text-muted-fg/60">
                  <span className="mr-1.5 font-medium text-muted-fg/45">started</span>
                  {anchors.started}
                </p>
              ) : null}
              {anchors.latest ? (
                <p className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-fg/80">
                  <span className="mr-1.5 font-medium text-muted-fg/45">latest</span>
                  {anchors.latest.text}
                </p>
              ) : null}
            </div>
          ) : preview && preview !== heading ? (
            // Older hosts predate the anchors; fall back to the single snippet.
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-fg/70">{preview}</p>
          ) : null}
        </div>
        <CaretRight size={16} className="mt-1 shrink-0 text-muted-fg/50" />
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
}: {
  summary: ExternalSessionSummary;
  lanes: LaneComboboxLane[];
  targetLaneId: string;
  targetLaneName: string;
  importingKey: string | null;
  refreshing: boolean;
  onBack: () => void;
  onTargetLaneChange: (laneId: string) => void;
  onImport: (affordance: ImportAffordance) => void;
  onOpenExisting?: (ref: ImportedSessionRef) => void;
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
  const preview = summary.preview?.trim();
  const messages = summary.messages ?? [];

  const choose = (affordance: ImportAffordance) => {
    if (
      summary.possiblyActive
      && affordance.mode === "resume"
      && !window.confirm("This session may still be open elsewhere. Close the other CLI before continuing the original, or create a copy instead. Continue anyway?")
    ) {
      return;
    }
    onImport(affordance);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
      >
        <ArrowLeft size={13} /> All sessions
      </button>

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
        <div className="flex items-start gap-3">
          <ToolLogo toolType={PROVIDER_TOOL_TYPE[summary.provider]} size={28} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[16px] font-semibold text-fg">{heading}</h3>
              {summary.alreadyImported ? (
                <span className="rounded-full bg-emerald-500/[0.1] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">In ADE</span>
              ) : null}
              {summary.possiblyActive ? (
                <span className="rounded-full bg-amber-500/[0.1] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">May be open elsewhere</span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-fg/70">
              <span>{providerDisplayName(summary.provider)}</span>
              {formatUpdatedAt(summary.updatedAt) ? <span>· {formatUpdatedAt(summary.updatedAt)}</span> : null}
              {summary.messageCount != null ? (
                <span>· {summary.messageCount} prompt{summary.messageCount === 1 ? "" : "s"}</span>
              ) : null}
            </div>
          </div>
        </div>
        {messages.length > 0 ? (
          /*
            The thread is what you are actually identifying, so it gets the room
            the old fixed-height dialog was wasting below the actions. Bounded
            and scrollable so long samples never push the action grid off-screen.
          */
          <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.06] bg-black/10">
            <div className="flex items-center gap-2 border-b border-white/[0.05] px-4 py-2 text-[10px] text-muted-fg/55">
              <span>Last {messages.length} {messages.length === 1 ? "message" : "messages"}</span>
              <span className="ml-auto truncate font-mono text-[9.5px] text-muted-fg/40" title={summary.id}>{summary.id}</span>
            </div>
            {/* Focusable so keyboard-only users can scroll a transcript that
                overflows; nothing inside it is otherwise focusable. */}
            <div
              className="max-h-[280px] overflow-y-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/40"
              tabIndex={0}
              role="region"
              aria-label="Session conversation"
            >
              {messages.map((message, index) => (
                <div
                  key={`${message.at ?? index}-${index}`}
                  className={cn(
                    "flex gap-3 px-4 py-2.5 text-[11.5px] leading-relaxed",
                    index > 0 && "border-t border-white/[0.035]",
                  )}
                >
                  <span
                    className={cn(
                      "w-8 shrink-0 pt-px text-[9.5px] font-semibold uppercase tracking-wide",
                      message.role === "user" ? "text-violet-300/85" : "text-emerald-300/70",
                    )}
                  >
                    {message.role === "user" ? "you" : "ADE"}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 whitespace-pre-wrap break-words",
                      message.role === "user" ? "text-fg/85" : "text-muted-fg/80",
                    )}
                  >
                    {message.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : preview ? (
          <div className="mt-4 whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3 text-[12px] leading-relaxed text-muted-fg/85">
            {preview}
          </div>
        ) : (
          <p className="mt-4 text-[11px] text-muted-fg/60">No conversational preview was recoverable for this session.</p>
        )}
        <dl className="mt-4 grid gap-2 text-[10.5px] sm:grid-cols-2">
          {/* `dir="rtl"` moves the overflow ellipsis to the start of the line
              so a path that is still too long loses its drive/home prefix
              rather than the folder that identifies it; the `<bdi>` keeps the
              path itself reading left-to-right. */}
          <div className="min-w-0"><dt className="text-muted-fg/50">Original folder</dt><dd className="truncate text-left font-mono text-muted-fg/80" dir="rtl" title={summary.cwd ?? undefined}><bdi dir="ltr">{shortenCwd(summary.cwd, 5)}</bdi></dd></div>
          <div className="min-w-0"><dt className="text-muted-fg/50">Provider session</dt><dd className="truncate font-mono text-muted-fg/80" title={summary.id}>{summary.id}</dd></div>
        </dl>
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-fg">Import into</div>
            <div className="mt-0.5 text-[10.5px] text-muted-fg/65">Actions update to match the selected lane and provider.</div>
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
        <section className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.04] p-4">
          <div>
            <div className="text-[12px] font-semibold text-fg">Already imported</div>
            <div className="mt-0.5 text-[10.5px] text-muted-fg/70">Open the existing {importedRef.kind === "chat" ? "ADE chat" : "CLI session"}, or create another copy below.</div>
          </div>
          <button type="button" onClick={() => onOpenExisting(importedRef)} className="shrink-0 rounded-full bg-emerald-300 px-4 py-2 text-[11px] font-semibold text-[#0F0D14]">Open existing</button>
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-fg">
          Choose an action for {targetLaneName}
          {refreshing ? <CircleNotch size={12} className="animate-spin text-muted-fg" /> : null}
        </div>
        {summary.possiblyActive ? (
          <div className="mb-3 flex gap-2 rounded-xl border border-amber-400/15 bg-amber-500/[0.04] px-3 py-2 text-[10.5px] leading-relaxed text-amber-200/80">
            <Warning size={13} className="mt-px shrink-0" /> Creating a copy is safest while the original may still be open.
          </div>
        ) : null}
        {available.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {available.map((affordance) => {
              const busy = importingKey === `${summary.id}:${affordance.kind}`;
              return (
                <button
                  key={affordance.kind}
                  type="button"
                  disabled={Boolean(importingKey) || refreshing}
                  onClick={() => choose(affordance)}
                  className="rounded-xl border border-white/[0.09] bg-white/[0.025] p-4 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.05] disabled:opacity-50"
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
  );
}
