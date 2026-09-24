import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, DownloadSimple, FolderSimple, Warning } from "@phosphor-icons/react";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import {
  importProviderLabel,
  planImport,
  type ImportPlan,
  type ImportPlanAction,
  type ImportSurface,
} from "../../../../shared/externalSessionPolicy";
import { EXTERNAL_SESSION_PROVIDERS } from "../../../../shared/types/externalSessions";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import type { LaneComboboxLane } from "../LaneCombobox";
import {
  getExternalSessionsApi,
  normalizeListResult,
  type ExternalSessionImportResult,
  type ExternalSessionProvider,
  type ExternalSessionSource,
  type ExternalSessionSummary,
} from "./contract";
import {
  ALL_LANES_ID,
  countBy,
  defaultForkModel,
  defaultLaneOf,
  hasPrompts,
  homeLaneIdIn,
  laneFilterKey,
  matchesLaneFilter,
  matchesProviderFilter,
  matchesSearch,
  OTHER_FOLDERS_ID,
  readImportedSessionRef,
  readSurfacePreference,
  replaceProviderRows,
  sessionKey,
  sessionPlace,
  sortByRecent,
  writeSurfacePreference,
  type ImportedSessionRef,
  type ProviderFilter,
  type SessionPlace,
} from "./importBrowserModel";
import { ImportActionBar } from "./ImportActionBar";
import { ImportSessionList, type SessionGroup } from "./ImportSessionList";
import { ImportSessionPreview } from "./ImportSessionPreview";
import { ImportTopBar } from "./ImportTopBar";
import { sessionDateGroup } from "./sessionPresentation";

export { DEFAULT_FORK_MODEL } from "./importBrowserModel";

const BROWSE_LIMIT = 200;
/** How long "Continue anyway" stays armed after the first click on a live session. */
const LIVE_CONFIRM_MS = 4000;
const SCAN_RETRY_DELAY_MS = 2500;

export type ImportSessionBrowserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The lane the dialog was opened from. Read once per open; later changes never move the target. */
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

function scanFailureMessage(machineName: string): string {
  return `ADE couldn't scan sessions on ${machineName}. Check that this computer has the project open, then try again.`;
}

function CenterState({
  icon,
  title,
  detail,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string | null;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[160px] flex-1 flex-col items-center justify-center px-6 py-8 text-center">
      {icon ? <div className="mb-2.5 text-muted-fg/60">{icon}</div> : null}
      <div className="text-[12.5px] font-medium text-fg/90">{title}</div>
      {detail ? <div className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted-fg/60">{detail}</div> : null}
      {action}
    </div>
  );
}

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
  // The lane the dialog opened from, captured on open. The Work view's lane
  // can change underneath an open dialog; nothing here may follow it.
  const [openedLaneId, setOpenedLaneId] = useState<string | null>(open ? laneId : null);
  if (open && openedLaneId === null) setOpenedLaneId(laneId);
  if (!open && openedLaneId !== null) setOpenedLaneId(null);
  const openLaneId = openedLaneId ?? laneId;

  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [pendingProviders, setPendingProviders] = useState<ExternalSessionProvider[]>([]);
  /** True once a scan of the current source finished; a refresh keeps it. */
  const [scanDone, setScanDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failedProviders, setFailedProviders] = useState<ExternalSessionProvider[]>([]);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [laneFilterChoice, setLaneFilterChoice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [targetChoice, setTargetChoice] = useState<{ key: string; laneId: string } | null>(null);
  const [surfacePrefs, setSurfacePrefs] = useState<Partial<Record<ExternalSessionProvider, ImportSurface>>>({});
  const [modelChoice, setModelChoice] = useState<{ key: string; model: string } | null>(null);
  // One action at a time waits on a second press, keyed to the row, surface and
  // lane it was armed for. `confirm`: continuing a live session. `copy`: a chat
  // copy asks for its model first, so the first "Copy" click shows the picker
  // and the next click (or Enter) makes the copy.
  const [armed, setArmed] = useState<{ token: string; kind: "confirm" | "copy" } | null>(null);
  // Enter never imports the row the dialog picked on its own: the user must
  // have chosen a row (click, arrow keys) or typed a search first.
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [importing, setImporting] = useState<{ key: string; mode: ImportPlanAction["mode"] } | null>(null);
  const [importError, setImportError] = useState<{ key: string; message: string } | null>(null);
  const requestSeq = useRef(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Sources (which computer to scan) ────────────────────────────────────
  const fallbackLanes = useMemo<LaneComboboxLane[]>(
    () => lanes.length ? lanes : [{ id: laneId, name: laneName }],
    [laneId, laneName, lanes],
  );
  const sourceOptions = useMemo<ExternalSessionSource[]>(
    () => sources?.length ? sources : [{
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      lanes: fallbackLanes,
      binding: null,
      runtimePin: null,
      online: true,
    }],
    [fallbackLanes, sources],
  );
  const defaultSource = sourceOptions.find((source) => source.machineId === THIS_MACHINE_ID)
    ?? sourceOptions[0]
    ?? null;
  const defaultSourceId = defaultSource?.machineId ?? null;
  const [selectedSourceId, setSelectedSourceId] = useState(defaultSourceId);
  const [sourceSelectionTouched, setSourceSelectionTouched] = useState(false);
  const selectedSource = sourceOptions.find((source) => source.machineId === selectedSourceId)
    ?? defaultSource;
  const machineName = selectedSource?.machineName ?? THIS_MACHINE_NAME;
  const runtimePin = selectedSource?.runtimePin ?? null;
  const availableLanes = useMemo<Array<LaneComboboxLane & { laneType?: string | null }>>(
    () => selectedSource?.lanes.length ? selectedSource.lanes : fallbackLanes,
    [fallbackLanes, selectedSource],
  );
  const lanesById = useMemo(() => new Map(availableLanes.map((lane) => [lane.id, lane])), [availableLanes]);
  // The scan passes a lane as context for the host. Derived from the lane
  // captured on open, so a Work lane switch never triggers a rescan.
  const scanLaneId = defaultLaneOf(availableLanes, openLaneId);
  const fallbackTargetLaneId = scanLaneId;

  const resetBrowseState = useCallback(() => {
    setSessions([]);
    setScanDone(false);
    setLoadError(null);
    setFailedProviders([]);
    setProviderFilter("all");
    setLaneFilterChoice(null);
    setQuery("");
    setSelectedKey(null);
    setTargetChoice(null);
    setModelChoice(null);
    setArmed(null);
    setSelectionTouched(false);
    setImportError(null);
  }, []);

  // Closing always returns the next open to this computer with fresh state.
  useEffect(() => {
    if (open) return;
    requestSeq.current += 1;
    setPendingProviders([]);
    setImporting(null);
    setSelectedSourceId((current) => current === defaultSourceId ? current : defaultSourceId);
    setSourceSelectionTouched(false);
    resetBrowseState();
  }, [defaultSourceId, open, resetBrowseState]);

  // A source can drop out of the live catalog while the dialog is open.
  useEffect(() => {
    const sourceStillExists = selectedSourceId != null
      && sourceOptions.some((source) => source.machineId === selectedSourceId);
    if (!sourceStillExists || (!sourceSelectionTouched && selectedSourceId !== defaultSourceId)) {
      setSelectedSourceId((current) => current === defaultSourceId ? current : defaultSourceId);
      setSourceSelectionTouched(false);
    }
  }, [defaultSourceId, selectedSourceId, sourceOptions, sourceSelectionTouched]);

  const handleSourceChange = useCallback((nextSourceId: string) => {
    const nextSource = sourceOptions.find((source) => source.machineId === nextSourceId);
    if (!nextSource || !nextSource.online) return;
    setSelectedSourceId(nextSourceId);
    setSourceSelectionTouched(true);
    resetBrowseState();
  }, [resetBrowseState, sourceOptions]);

  // ── Scan ────────────────────────────────────────────────────────────────
  const load = useCallback(async (attempt = 0) => {
    const api = getExternalSessionsApi();
    if (!api) {
      setLoadError("Importing sessions isn't available in this window.");
      setSessions([]);
      setPendingProviders([]);
      return;
    }
    const seq = ++requestSeq.current;
    const providers = [...EXTERNAL_SESSION_PROVIDERS];
    setLoadError(null);
    setFailedProviders([]);
    setPendingProviders(providers);
    let failures = 0;
    await Promise.all(providers.map(async (provider) => {
      try {
        const request = {
          providers: [provider],
          scope: "project" as const,
          ...(scanLaneId ? { laneId: scanLaneId } : {}),
          limit: BROWSE_LIMIT,
        };
        const result = runtimePin ? await api.list(request, runtimePin) : await api.list(request);
        if (seq !== requestSeq.current) return;
        const rows = normalizeListResult(result).filter(hasPrompts);
        // A refresh swaps each provider's rows in place, so the list never
        // blanks while the rest of the scan is still running.
        setSessions((prev) => replaceProviderRows(prev, provider, rows));
      } catch {
        if (seq !== requestSeq.current) return;
        failures += 1;
        setFailedProviders((prev) => prev.includes(provider) ? prev : [...prev, provider]);
      } finally {
        if (seq === requestSeq.current) {
          setPendingProviders((prev) => prev.filter((p) => p !== provider));
        }
      }
    }));
    if (seq !== requestSeq.current) return;
    // Every provider failing at once is a host that is not ready yet (a brain
    // still starting), not ten broken providers: wait and scan once more
    // before showing the error.
    if (failures === providers.length && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_RETRY_DELAY_MS));
      if (seq !== requestSeq.current) return;
      await load(1);
      return;
    }
    setScanDone(true);
    if (failures === providers.length) setLoadError(scanFailureMessage(machineName));
  }, [machineName, runtimePin, scanLaneId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Open ready to type: search takes focus, and ↑/↓/Enter work from there.
  // Deferred past the dialog's own open auto-focus.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Scanning from the moment the dialog opens, not from when the effect runs,
  // so the first frame never claims there are no sessions.
  const loading = pendingProviders.length > 0 || (open && !scanDone && !loadError);

  // ── Filters, counts, list ───────────────────────────────────────────────
  const places = useMemo(() => {
    const map = new Map<string, SessionPlace>();
    for (const summary of sessions) map.set(sessionKey(summary), sessionPlace(summary, lanesById));
    return map;
  }, [lanesById, sessions]);
  const placeOf = useCallback(
    (summary: ExternalSessionSummary) => places.get(sessionKey(summary)) ?? sessionPlace(summary, lanesById),
    [lanesById, places],
  );

  const scanLaneKeys = useMemo(() => new Set(sessions.map(laneFilterKey).filter((key): key is string => key != null)), [sessions]);
  const openLaneHasSessions = scanLaneKeys.has(openLaneId);
  // Default: the lane the dialog came from — kept while the scan may still
  // find its sessions, dropped to All lanes once the scan shows it has none.
  const laneFilter = laneFilterChoice
    ?? ((openLaneHasSessions || (loading && lanesById.has(openLaneId))) ? openLaneId : ALL_LANES_ID);

  const providerCountsAll = useMemo(() => countBy(sessions, (s) => s.provider), [sessions]);
  const effectiveProviderFilter: ProviderFilter = providerFilter !== "all" && providerCountsAll.has(providerFilter)
    ? providerFilter
    : "all";

  const inLane = useMemo(() => sessions.filter((s) => matchesLaneFilter(s, laneFilter)), [laneFilter, sessions]);
  const inProvider = useMemo(
    () => sessions.filter((s) => matchesProviderFilter(s, effectiveProviderFilter)),
    [effectiveProviderFilter, sessions],
  );
  const providerCounts = useMemo(() => countBy(inLane, (s) => s.provider), [inLane]);
  const laneCounts = useMemo(() => countBy(inProvider, laneFilterKey), [inProvider]);
  const providerChips = useMemo(
    // Only providers with a session under the current lane filter get a chip;
    // the chosen provider keeps its chip so the filter can be cleared.
    () => EXTERNAL_SESSION_PROVIDERS
      .filter((provider) => (providerCounts.get(provider) ?? 0) > 0 || provider === effectiveProviderFilter)
      .map((provider) => ({ provider, count: providerCounts.get(provider) ?? 0 })),
    [effectiveProviderFilter, providerCounts],
  );

  const laneOptions = useMemo<LaneComboboxLane[]>(() => {
    const options: LaneComboboxLane[] = [];
    const seen = new Set<string>();
    const detailOf = (id: string) => String(laneCounts.get(id) ?? 0);
    for (const lane of availableLanes) {
      if (!scanLaneKeys.has(lane.id) && lane.id !== laneFilter) continue;
      seen.add(lane.id);
      options.push({ id: lane.id, name: lane.name, color: lane.color, branchRef: lane.branchRef, detail: detailOf(lane.id) });
    }
    // A home lane this source's list does not carry still gets a row.
    for (const summary of sessions) {
      const home = summary.home;
      if (home?.kind !== "lane" || !home.laneId || seen.has(home.laneId)) continue;
      seen.add(home.laneId);
      options.push({
        id: home.laneId,
        name: home.laneName ?? "Lane",
        color: home.color,
        branchRef: home.branchRef,
        detail: detailOf(home.laneId),
      });
    }
    if (scanLaneKeys.has(OTHER_FOLDERS_ID) || laneFilter === OTHER_FOLDERS_ID) {
      options.push({
        id: OTHER_FOLDERS_ID,
        name: "Other folders",
        detail: detailOf(OTHER_FOLDERS_ID),
        icon: <FolderSimple size={12} className="shrink-0 text-muted-fg/60" />,
      });
    }
    return options;
  }, [availableLanes, laneCounts, laneFilter, scanLaneKeys, sessions]);

  const visible = useMemo(
    () => sortByRecent(inLane.filter((s) => (
      matchesProviderFilter(s, effectiveProviderFilter) && matchesSearch(s, placeOf(s), query)
    ))),
    [effectiveProviderFilter, inLane, placeOf, query],
  );
  // A search that finds nothing in the chosen lane may still match elsewhere;
  // the empty state offers those instead of a dead end.
  const matchesInOtherLanes = useMemo(() => {
    if (!query.trim() || laneFilter === ALL_LANES_ID) return 0;
    return sessions.filter((s) => (
      !matchesLaneFilter(s, laneFilter)
      && matchesProviderFilter(s, effectiveProviderFilter)
      && matchesSearch(s, placeOf(s), query)
    )).length;
  }, [effectiveProviderFilter, laneFilter, placeOf, query, sessions]);
  const groups = useMemo<SessionGroup[]>(() => {
    const result: SessionGroup[] = [];
    for (const summary of visible) {
      const label = sessionDateGroup(summary.updatedAt);
      const last = result.at(-1);
      if (last?.label === label) last.rows.push(summary);
      else result.push({ label, rows: [summary] });
    }
    return result;
  }, [visible]);

  // The first visible row is always selected, so the preview is never empty.
  const active = (selectedKey ? visible.find((s) => sessionKey(s) === selectedKey) : undefined) ?? visible[0] ?? null;
  const activeKey = active ? sessionKey(active) : null;
  const activePlace = active ? placeOf(active) : null;

  // ── Plan for the selected session ───────────────────────────────────────
  const activeProvider = active?.provider ?? null;
  const surfacePref = useMemo(
    () => activeProvider ? surfacePrefs[activeProvider] ?? readSurfacePreference(activeProvider) : null,
    [activeProvider, surfacePrefs],
  );
  const requestedTarget = active && targetChoice?.key === activeKey
    ? targetChoice.laneId
    : active
      ? homeLaneIdIn(active, lanesById) ?? fallbackTargetLaneId
      : null;
  const plan: ImportPlan | null = useMemo(() => {
    if (!active) return null;
    return planImport(active, {
      surface: surfacePref,
      targetLaneId: requestedTarget,
      originLaneId: scanLaneId,
      laneName: (id) => lanesById.get(id)?.name ?? null,
    });
  }, [active, lanesById, requestedTarget, scanLaneId, surfacePref]);
  const model = active
    ? (modelChoice?.key === activeKey ? modelChoice.model : defaultForkModel(active))
    : null;
  const importedRef = active?.alreadyImported ? readImportedSessionRef(active) : null;
  const needsLiveConfirm = plan?.primary?.confirmBeforeRun === true;
  const currentArmToken = active && plan ? `${activeKey}|${plan.surface}|${plan.targetLaneId}` : null;
  const armedHere = armed != null && armed.token === currentArmToken ? armed.kind : null;
  const confirming = needsLiveConfirm && armedHere === "confirm";
  const copyArmed = armedHere === "copy";

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const handleSelect = useCallback((key: string) => {
    setSelectedKey(key);
    setSelectionTouched(true);
    setImportError(null);
  }, []);

  const handleSurfaceChange = useCallback((surface: ImportSurface) => {
    if (!active) return;
    writeSurfacePreference(active.provider, surface);
    setSurfacePrefs((prev) => ({ ...prev, [active.provider]: surface }));
  }, [active]);

  const handleTargetLaneChange = useCallback((nextLaneId: string) => {
    if (!activeKey) return;
    setTargetChoice({ key: activeKey, laneId: nextLaneId });
  }, [activeKey]);

  const handleModelChange = useCallback((nextModel: string) => {
    if (!activeKey) return;
    setModelChoice({ key: activeKey, model: nextModel });
  }, [activeKey]);

  const runImport = useCallback(async (summary: ExternalSessionSummary, action: ImportPlanAction, laneForImport: string) => {
    const api = getExternalSessionsApi();
    const key = sessionKey(summary);
    if (!api) {
      setImportError({ key, message: "Importing sessions isn't available in this window." });
      return;
    }
    setImporting({ key, mode: action.mode });
    setImportError(null);
    try {
      const request = {
        provider: summary.provider,
        sessionId: summary.id,
        laneId: laneForImport,
        target: action.target,
        mode: action.mode,
        ...(action.needsModel && model ? { model } : {}),
      };
      const result = runtimePin ? await api.import(request, runtimePin) : await api.import(request);
      onImported(summary, result, selectedSource ?? undefined);
      onOpenChange(false);
    } catch {
      const verb = action.label.charAt(0).toLowerCase() + action.label.slice(1);
      setImportError({ key, message: `Couldn't ${verb} on ${machineName}.` });
    } finally {
      setImporting(null);
    }
  }, [machineName, model, onImported, onOpenChange, runtimePin, selectedSource]);

  const handleRun = useCallback((action: ImportPlanAction) => {
    if (!active || !plan || importing || !plan.targetLaneId) return;
    const token = currentArmToken;
    if (action === plan.secondary && action.needsModel && !copyArmed) {
      if (token) setArmed({ token, kind: "copy" });
      return;
    }
    if (action.confirmBeforeRun && !confirming) {
      if (token) setArmed({ token, kind: "confirm" });
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      // Only the live-continue confirm times out; an armed copy waits for the user.
      confirmTimer.current = setTimeout(
        () => setArmed((prev) => prev?.kind === "confirm" ? null : prev),
        LIVE_CONFIRM_MS,
      );
      return;
    }
    setArmed(null);
    void runImport(active, action, plan.targetLaneId);
  }, [active, confirming, copyArmed, currentArmToken, importing, plan, runImport]);

  const handleOpenExisting = useCallback((ref: ImportedSessionRef) => {
    onOpenExisting?.(ref, selectedSource ?? undefined);
    onOpenChange(false);
  }, [onOpenChange, onOpenExisting, selectedSource]);

  const runPrimary = useCallback(() => {
    if (!active) return;
    if (importedRef && onOpenExisting) {
      handleOpenExisting(importedRef);
      return;
    }
    if (copyArmed && plan?.secondary) {
      handleRun(plan.secondary);
      return;
    }
    if (plan?.primary) handleRun(plan.primary);
  }, [active, copyArmed, handleOpenExisting, handleRun, importedRef, onOpenExisting, plan]);

  // ── Keyboard: ↑/↓ move the selection, Enter runs the main action ─────────
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const inSearch = Boolean(target.closest("[data-import-search]"));
    const inField = Boolean(target.closest(
      "input,textarea,select,[contenteditable='true'],[role='combobox'],[role='listbox']:not([aria-label='Sessions']),[role='menu']",
    ));
    if (inField && !inSearch) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (target.closest("[data-import-transcript],[role='radiogroup']") || !visible.length) return;
      event.preventDefault();
      const index = activeKey ? visible.findIndex((s) => sessionKey(s) === activeKey) : -1;
      const nextIndex = event.key === "ArrowDown"
        ? Math.min(index + 1, visible.length - 1)
        : Math.max(index - 1, 0);
      const next = visible[nextIndex];
      if (next) handleSelect(sessionKey(next));
      return;
    }
    if (event.key === "Enter") {
      // A focused control keeps its own Enter.
      if (target.closest("button,a,[role='radio']") && !target.closest("[data-import-row]")) return;
      event.preventDefault();
      if (!selectionTouched && !query.trim() && !target.closest("[data-import-row]")) return;
      runPrimary();
    }
  }, [activeKey, handleSelect, query, runPrimary, selectionTouched, visible]);

  // ── Render ──────────────────────────────────────────────────────────────
  const failedNotice = failedProviders.length
    ? `${failedProviders.map(importProviderLabel).join(", ")} couldn't be scanned.`
    : null;
  const laneFilterName = laneFilter === OTHER_FOLDERS_ID
    ? "other folders"
    : laneOptions.find((lane) => lane.id === laneFilter)?.name ?? lanesById.get(laneFilter)?.name ?? "this lane";
  const noSessionsAtAll = !loading && !loadError && sessions.length === 0;
  const searching = query.trim().length > 0;
  const showAllLanesLabel = searching
    ? matchesInOtherLanes > 0
      ? `Show ${matchesInOtherLanes} in other lanes`
      : null
    : "Show all lanes";
  const listEmpty = laneFilter !== ALL_LANES_ID ? (
    <CenterState
      title={searching ? `No matches in ${laneFilterName}` : `No sessions in ${laneFilterName}`}
      action={showAllLanesLabel ? (
        <button
          type="button"
          onClick={() => setLaneFilterChoice(ALL_LANES_ID)}
          className="mt-3 inline-flex h-7 items-center rounded-full border border-white/[0.1] px-3 text-[11px] text-fg/85 transition-colors hover:bg-white/[0.05]"
        >
          {showAllLanesLabel}
        </button>
      ) : undefined}
    />
  ) : (
    <CenterState title="No matching sessions" />
  );

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Import session"
      icon={DownloadSimple}
      width="min(1180px, calc(100vw - 4rem))"
      height="min(860px, calc(100dvh - 4rem))"
      scrollBody={false}
      busy={Boolean(importing)}
    >
      {/* Bleeds past the shell's body padding so the split view runs edge to edge. */}
      <div
        className="-mx-4 -my-3 flex h-[calc(100%+1.5rem)] min-h-0 flex-col sm:-mx-5 sm:-my-4 sm:h-[calc(100%+2rem)]"
        onKeyDown={onKeyDown}
      >
        <ImportTopBar
          providerChips={providerChips}
          totalCount={inLane.length}
          providerFilter={effectiveProviderFilter}
          onProviderFilterChange={setProviderFilter}
          laneOptions={laneOptions}
          laneFilter={laneFilter}
          onLaneFilterChange={setLaneFilterChoice}
          laneFilterTotal={inProvider.length}
          query={query}
          onQueryChange={setQuery}
          searchRef={searchRef}
          loading={loading}
          onRefresh={() => void load()}
          sources={sourceOptions}
          selectedSourceId={selectedSourceId}
          onSourceChange={handleSourceChange}
          sourceDisabled={Boolean(importing)}
        />
        {loadError && !sessions.length ? (
          <CenterState
            icon={<Warning size={18} className="text-amber-400" />}
            title="Sessions couldn't be loaded"
            detail={loadError}
            action={(
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.1] px-3 text-[11px] text-fg hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowClockwise size={12} className={loading ? "animate-spin" : undefined} /> Retry scan
              </button>
            )}
          />
        ) : noSessionsAtAll ? (
          <CenterState
            icon={<DownloadSimple size={18} />}
            title="No sessions found"
            detail={`Checked ${EXTERNAL_SESSION_PROVIDERS.map(importProviderLabel).join(", ")} on ${machineName}.`}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-[360px] shrink-0 flex-col border-r border-white/[0.06]">
              <ImportSessionList
                groups={groups}
                activeKey={activeKey}
                placeOf={placeOf}
                hidePlace={laneFilter !== ALL_LANES_ID && laneFilter !== OTHER_FOLDERS_ID}
                onSelect={handleSelect}
                loading={loading}
                empty={listEmpty}
                notice={failedNotice}
              />
            </aside>
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Session preview">
              {active && activePlace && plan ? (
                <>
                  <ImportSessionPreview
                    key={activeKey}
                    summary={active}
                    place={activePlace}
                    runtimePin={runtimePin}
                  />
                  <ImportActionBar
                    plan={plan}
                    onSurfaceChange={handleSurfaceChange}
                    lanes={availableLanes}
                    homeLane={activePlace.kind === "lane" ? { name: activePlace.name, color: activePlace.color } : null}
                    onTargetLaneChange={handleTargetLaneChange}
                    model={model}
                    onModelChange={handleModelChange}
                    running={importing?.key === activeKey ? importing.mode : null}
                    disabled={Boolean(importing)}
                    confirming={confirming}
                    copyArmed={copyArmed}
                    onCancelCopy={() => setArmed((prev) => prev?.kind === "copy" ? null : prev)}
                    noteTone={needsLiveConfirm ? "warning" : "muted"}
                    error={importError?.key === activeKey ? importError.message : null}
                    onRun={handleRun}
                    openExisting={importedRef && onOpenExisting ? { onOpen: () => handleOpenExisting(importedRef) } : null}
                  />
                </>
              ) : loading ? (
                <div className="flex flex-1 flex-col gap-4 px-6 py-6" aria-hidden="true">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-white/[0.05]" />
                  <div className="ml-auto h-9 w-1/2 animate-pulse rounded-2xl bg-white/[0.04]" />
                  <div className="h-4 w-3/5 animate-pulse rounded bg-white/[0.035]" />
                </div>
              ) : null}
            </section>
          </div>
        )}
      </div>
    </LaneDialogShell>
  );
}
