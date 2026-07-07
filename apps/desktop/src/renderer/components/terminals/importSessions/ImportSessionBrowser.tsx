import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  CircleNotch,
  DownloadSimple,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { relativeWhen } from "../../../lib/format";
import { cn } from "../../ui/cn";

/** Backend timestamps arrive as epoch millis (nullable); format defensively. */
function formatUpdatedAt(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return relativeWhen(new Date(ms).toISOString());
}

/** Last path segment of a cwd (e.g. the repo/folder name), null when missing. */
function lastPathSegment(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segments = cwd.split("/").filter(Boolean);
  return segments.length ? (segments[segments.length - 1] ?? null) : null;
}

/**
 * Heading fallback for sessions the provider couldn't title: the folder name
 * (or a shortened path) plus the relative time, so the row is still
 * identifiable and never collapses onto the preview snippet.
 */
function fallbackHeading(summary: ExternalSessionSummary): string {
  const where = lastPathSegment(summary.cwd) ?? shortenCwd(summary.cwd);
  const when = formatUpdatedAt(summary.updatedAt);
  return when ? `${where} · ${when}` : where;
}
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ToolLogo } from "../ToolLogos";
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

const PROVIDER_FILTERS: Array<{ id: ExternalSessionProvider | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "droid", label: "Droid" },
  { id: "opencode", label: "OpenCode" },
];

/** Every provider we scan when no specific filter is applied. */
const ALL_PROVIDERS: ExternalSessionProvider[] = ["claude", "codex", "cursor", "droid", "opencode"];

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
  onImported: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
  /** Navigate to an already-imported ADE session instead of re-importing it. */
  onOpenExisting?: (ref: ImportedSessionRef) => void;
};

export function ImportSessionBrowser({
  open,
  onOpenChange,
  laneId,
  onImported,
  onOpenExisting,
}: ImportSessionBrowserProps) {
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [pendingProviders, setPendingProviders] = useState<ExternalSessionProvider[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSeq = useRef(0);

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
    setPendingProviders(providers);
    let failures = 0;
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await api.list({ providers: [provider], scope, laneId });
          if (seq !== requestSeq.current) return;
          setSessions((prev) => mergeSessions(prev, normalizeListResult(result)));
        } catch {
          if (seq !== requestSeq.current) return;
          failures += 1;
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
  }, [laneId, scope, providerFilter]);

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
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => (providerFilter === "all" ? true : s.provider === providerFilter))
      .filter((s) =>
        q
          ? (s.title ?? "").toLowerCase().includes(q) || (s.preview ?? "").toLowerCase().includes(q)
          : true,
      )
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sessions, providerFilter, query]);

  useEffect(() => {
    setActiveIndex((idx) => Math.min(idx, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const runImport = useCallback(
    async (summary: ExternalSessionSummary, affordance: ImportAffordance) => {
      if (!affordance.enabled || importing) return;
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
          laneId,
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
    [importing, laneId, onImported, onOpenChange],
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
        const primary = importAffordancesFor(summary).find((a) => a.enabled);
        if (primary) {
          event.preventDefault();
          void runImport(summary, primary);
        }
      }
    },
    [activeIndex, runImport, visible],
  );

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Import session"
      icon={DownloadSimple}
      widthClassName="w-[min(980px,calc(100vw-4rem))]"
      heightClassName="h-[min(860px,calc(100dvh-4rem))]"
      busy={Boolean(importing)}
    >
      <div className="flex h-full min-h-0 flex-col gap-3" onKeyDown={onListKeyDown}>
        {/* Filters */}
        <div className="flex shrink-0 flex-col gap-2">
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
                placeholder="Search by title"
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
        </div>

        {importError ? (
          <div className="flex shrink-0 items-start gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
            <Warning size={14} className="mt-px shrink-0" />
            <span>{importError}</span>
          </div>
        ) : null}

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {loading && !sessions.length ? (
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
                  importingKey={importing}
                  onActivate={() => setActiveIndex(index)}
                  onImport={(aff) => void runImport(summary, aff)}
                  onOpenExisting={onOpenExisting ? handleOpenExisting : undefined}
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
  importingKey,
  onActivate,
  onImport,
  onOpenExisting,
}: {
  summary: ExternalSessionSummary;
  active: boolean;
  importingKey: string | null;
  onActivate: () => void;
  onImport: (affordance: ImportAffordance) => void;
  onOpenExisting?: (ref: ImportedSessionRef) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const affordances = useMemo(() => importAffordancesFor(summary), [summary]);
  // When the backend knows this external session was already imported, offer a
  // single "Open in ADE" that jumps to the existing session rather than the
  // per-target "Open as …" re-import actions; the fork actions still stand so
  // the user can branch a fresh copy.
  const importedRef =
    summary.alreadyImported && onOpenExisting ? readImportedSessionRef(summary) : null;
  // One obvious default per row: the hero chat action if present, otherwise the
  // first runnable action (the most-likely CLI path for chat-less providers).
  // For an imported row the "Open in ADE" button is the primary, so no import
  // affordance should also render as primary.
  const primaryKind = useMemo(
    () =>
      importedRef
        ? null
        : (affordances.find((a) => a.hero) ?? affordances.find((a) => a.enabled))?.kind ?? null,
    [affordances, importedRef],
  );
  const chatActions = affordances.filter((a) => a.target === "chat");
  const cliActions = affordances.filter((a) => a.target === "cli");
  // For imported rows we drop the "Open" (resume) actions in favor of the single
  // "Open in ADE" and keep only the fork actions.
  const forkChatActions = chatActions.filter((a) => a.mode === "fork");
  const forkCliActions = cliActions.filter((a) => a.mode === "fork");

  // Real provider title when there is one; otherwise a path+time fallback so the
  // heading is always distinct from the preview snippet.
  const title = summary.title?.trim();
  const hasTitle = Boolean(title);
  const heading = hasTitle ? (title as string) : fallbackHeading(summary);
  const preview = summary.preview?.trim();

  // Labels are self-evident (the 2×2 {ADE chat | CLI session} × {Open | Fork}),
  // so buttons carry no hover-only tooltip — meaning stays visible.
  const renderAction = (aff: ImportAffordance) => {
    const busy = importingKey === `${summary.id}:${aff.kind}`;
    const isPrimary = aff.enabled && aff.kind === primaryKind;
    return (
      <button
        key={aff.kind}
        type="button"
        disabled={!aff.enabled || Boolean(importingKey)}
        onClick={() => onImport(aff)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[11.5px] font-medium transition-all disabled:cursor-not-allowed",
          isPrimary
            ? "text-[#0F0D14] hover:brightness-110 disabled:opacity-50"
            : aff.enabled
              ? "border border-white/[0.1] bg-white/[0.03] text-fg hover:bg-white/[0.07]"
              : "border border-white/[0.05] bg-transparent text-muted-fg/40",
        )}
        style={isPrimary ? { background: "#A78BFA" } : undefined}
      >
        {busy ? <CircleNotch size={11} className="animate-spin" /> : null}
        {aff.label}
      </button>
    );
  };

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
      <div className="flex items-start gap-3">
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
                  {summary.messageCount} msg{summary.messageCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
            {/* The path-fallback heading already carries the folder, so only add
                the cwd chip when a real title occupies the heading. */}
            {hasTitle && summary.cwd ? (
              <span
                className="ml-0.5 max-w-[240px] truncate rounded border border-white/[0.05] bg-white/[0.03] px-1.5 py-px font-mono text-[9.5px] text-muted-fg/60"
                title={summary.cwd}
              >
                {summary.cwd}
              </span>
            ) : null}
          </div>

          {preview ? (
            <div className="mt-2">
              <button
                type="button"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[10.5px] font-medium text-muted-fg/60 transition-colors hover:text-fg"
              >
                <CaretRight
                  size={10}
                  weight="bold"
                  className={cn("transition-transform", previewOpen && "rotate-90")}
                />
                Preview
              </button>
              {previewOpen ? (
                <div className="mt-1 max-h-52 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-muted-fg/70">
                  {preview}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Actions — grouped "open as chat" vs "continue as terminal" so the
              chat/terminal and continue/fork distinctions read at a glance. For
              already-imported rows a single "Open in ADE" replaces the re-import
              "Open" actions, with the fork actions still available alongside. */}
          {importedRef ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <button
                type="button"
                disabled={Boolean(importingKey)}
                onClick={() => onOpenExisting?.(importedRef)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[11.5px] font-medium text-[#0F0D14] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "#A78BFA" }}
              >
                Open in ADE
              </button>
              {forkChatActions.length || forkCliActions.length ? (
                <span aria-hidden className="hidden h-4 w-px bg-white/[0.08] sm:block" />
              ) : null}
              {forkChatActions.length ? (
                <div className="flex items-center gap-1.5">{forkChatActions.map(renderAction)}</div>
              ) : null}
              {forkCliActions.length ? (
                <div className="flex items-center gap-1.5">{forkCliActions.map(renderAction)}</div>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              {chatActions.length ? (
                <div className="flex items-center gap-1.5">{chatActions.map(renderAction)}</div>
              ) : null}
              {chatActions.length && cliActions.length ? (
                <span aria-hidden className="hidden h-4 w-px bg-white/[0.08] sm:block" />
              ) : null}
              {cliActions.length ? (
                <div className="flex items-center gap-1.5">{cliActions.map(renderAction)}</div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
