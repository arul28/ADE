import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
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
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ProviderChip } from "../ProviderChip";
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

type ProviderFilter = ExternalSessionProvider | "all";

export type ImportSessionBrowserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  laneId: string;
  laneName: string;
  onImported: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
};

export function ImportSessionBrowser({
  open,
  onOpenChange,
  laneId,
  laneName,
  onImported,
}: ImportSessionBrowserProps) {
  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSeq = useRef(0);

  const scope: "project" | "all" = showAllFolders ? "all" : "project";

  const load = useCallback(async () => {
    const api = getExternalSessionsApi();
    if (!api) {
      setLoadError("Importing sessions isn't available in this window.");
      setSessions([]);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.list({ scope, laneId });
      if (seq !== requestSeq.current) return;
      setSessions(normalizeListResult(result));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof Error ? err.message : "Couldn't load external sessions.");
      setSessions([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [laneId, scope]);

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
      description={`Continue an external CLI session in ${laneName}.`}
      icon={DownloadSimple}
      widthClassName="w-[min(680px,calc(100vw-1rem))]"
      heightClassName="h-[min(680px,calc(100dvh-2rem))]"
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
                    isAll ? "px-3" : "pl-1.5 pr-3",
                    selected
                      ? "border-white/[0.14] bg-white/[0.08] text-fg"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/80 hover:text-fg",
                  )}
                >
                  {filter.id !== "all" ? (
                    <ProviderChip
                      provider={filter.id}
                      toolType={PROVIDER_TOOL_TYPE[filter.id]}
                      size="sm"
                      className={cn(
                        "transition-opacity",
                        selected ? "opacity-100" : "opacity-80",
                      )}
                    />
                  ) : null}
                  {filter.label}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-2">
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
            <ul className="flex flex-col gap-1.5">
              {visible.map((summary, index) => (
                <ImportSessionRow
                  key={`${summary.provider}:${summary.id}`}
                  summary={summary}
                  active={index === activeIndex}
                  importingKey={importing}
                  onActivate={() => setActiveIndex(index)}
                  onImport={(aff) => void runImport(summary, aff)}
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
}: {
  summary: ExternalSessionSummary;
  active: boolean;
  importingKey: string | null;
  onActivate: () => void;
  onImport: (affordance: ImportAffordance) => void;
}) {
  const affordances = useMemo(() => importAffordancesFor(summary), [summary]);
  const hint = affordances.find((a) => a.hint)?.hint;

  return (
    <li
      onMouseEnter={onActivate}
      className={cn(
        "rounded-xl border px-3 py-2.5 transition-colors",
        active
          ? "border-white/[0.14] bg-white/[0.05]"
          : "border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.035]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ProviderChip
          provider={summary.provider}
          toolType={PROVIDER_TOOL_TYPE[summary.provider]}
          size="md"
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-medium text-fg">
              {summary.title || "Untitled session"}
            </span>
            {summary.alreadyImported ? (
              <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-fg/80">
                Imported
              </span>
            ) : null}
            {summary.possiblyActive ? (
              <SmartTooltip
                content={{
                  label: "May be open elsewhere",
                  description:
                    "Continuing here takes over the session — close the other tool, or fork instead.",
                }}
              >
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/25 bg-amber-500/[0.08] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                  <Warning size={9} weight="fill" /> May be open elsewhere
                </span>
              </SmartTooltip>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-fg/70">
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
            {summary.cwd ? (
              <span
                className="ml-0.5 max-w-[240px] truncate rounded border border-white/[0.05] bg-white/[0.03] px-1.5 py-px font-mono text-[9.5px] text-muted-fg/60"
                title={summary.cwd}
              >
                {summary.cwd}
              </span>
            ) : null}
          </div>
          {summary.preview ? (
            <div className="mt-1 line-clamp-1 text-[11px] leading-snug text-muted-fg/60">
              {summary.preview}
            </div>
          ) : null}

          {/* Actions */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {affordances.map((aff) => {
              const key = `${summary.id}:${aff.kind}`;
              const busy = importingKey === key;
              const button = (
                <button
                  key={aff.kind}
                  type="button"
                  disabled={!aff.enabled || Boolean(importingKey)}
                  onClick={() => onImport(aff)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-all disabled:cursor-not-allowed",
                    aff.hero
                      ? "text-[#0F0D14] hover:brightness-110 disabled:opacity-50"
                      : aff.enabled
                        ? "border border-white/[0.1] bg-white/[0.03] text-fg hover:bg-white/[0.07]"
                        : "border border-white/[0.05] bg-transparent text-muted-fg/40",
                  )}
                  style={aff.hero ? { background: "#A78BFA" } : undefined}
                >
                  {busy ? <CircleNotch size={11} className="animate-spin" /> : null}
                  {aff.label}
                </button>
              );
              if (!aff.enabled && aff.disabledReason) {
                return (
                  <SmartTooltip key={aff.kind} content={{ label: aff.label, description: aff.disabledReason }}>
                    {button}
                  </SmartTooltip>
                );
              }
              return button;
            })}
          </div>
          {hint ? <div className="mt-1.5 text-[10.5px] leading-snug text-muted-fg/60">{hint}</div> : null}
        </div>
      </div>
    </li>
  );
}
