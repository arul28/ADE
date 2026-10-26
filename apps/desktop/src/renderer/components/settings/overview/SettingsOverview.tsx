import React from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Desktop,
  FolderSimple,
  HardDrive,
  HardDrives,
  Robot,
  UserCircle,
} from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import type { StorageSnapshot } from "../../../../shared/types/storage";
import { ModernSection } from "../primitives";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { AgentLaunchSetup } from "../../shared/AgentLaunchSetup";
import { UsageSparkline } from "../../usage/UsageSparks";
import { useAppStore } from "../../../state/appStore";
import { formatTokens } from "../../../lib/format";
import { categorySeries, formatBytes, formatMeasuredBytes, freeSpaceLevel } from "../storage/storageView";
import { CountBar, FreeSpaceMeter, seriesColor, useChartTheme } from "../health/healthCharts";
import { useProjectFix } from "../health/ProjectIssues";
import { laneBucket } from "../lanes/laneListModel";
import { settingsRouteFor, type SettingsTabId } from "../settingsManifest";
// Read only while rendering, so the import cycle with the tab table is safe.
import { STANDALONE_TAB_IDS } from "../settingsTabContent";
import { attentionAgentPrompt, useNeedsAttention, type AttentionItem } from "./useNeedsAttention";
import "../health/health.css";
import "./overview.css";

/** Rows shown before "Show N more". */
const INITIAL_ROWS = 5;

const DOT_STATE: Record<AttentionItem["severity"], "crit" | "warn" | undefined> = {
  problem: "crit",
  warning: "warn",
  note: undefined,
};

/**
 * Settings → Overview, where Settings opens: everything that needs attention
 * in one list, then a glance at this computer, this project and your account,
 * each linking to its page.
 */
export function SettingsOverview() {
  const navigate = useNavigate();
  const project = useAppStore((state) => state.project);
  const hasProject = Boolean(project?.rootPath);
  const attention = useNeedsAttention({ hasProject });
  const { items, sources, loading, checking } = attention;
  const [showAll, setShowAll] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);
  const [fixingId, setFixingId] = React.useState<string | null>(null);
  // The project's own fixes run on the machine that owns the project: the
  // tab's binding, so unpinned.
  const projectFix = useProjectFix(null, attention.setReport);

  const shown = showAll ? items : items.slice(0, INITIAL_ROWS);
  const hidden = items.length - shown.length;
  const problems = items.filter((item) => item.severity !== "note").length;
  const projectRoot = sources.report?.projectRoot ?? project?.rootPath ?? null;
  // With no project open, Settings shows only the pages it can reach (not
  // Providers, which needs a project to route through); a link to any other
  // page would go nowhere, so those rows keep their text but lose the link.
  const canOpen = (route: string): boolean => {
    if (hasProject) return true;
    const tab = new URL(route, "ade://settings").searchParams.get("tab");
    return tab == null || STANDALONE_TAB_IDS.has(tab as SettingsTabId);
  };

  const runFix = async (item: AttentionItem) => {
    if (item.projectIssue?.fix) {
      await projectFix.runFix(item.projectIssue);
      return;
    }
    const fix = item.fix;
    if (!fix || fixingId) return;
    if (fix.confirm) {
      const ok = await confirmDialog({ title: `${fix.label}?`, message: fix.confirm, confirmLabel: fix.label });
      if (!ok) return;
    }
    setFixingId(item.id);
    try {
      await fix.run();
      showToast({ tone: "success", title: `${fix.label}: done` });
      void attention.reload();
    } catch (err) {
      showToast({ tone: "error", title: `Couldn't ${fix.label.toLowerCase()}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setFixingId(null);
    }
  };

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="Overview"
        anchor="needs-attention"
        title={loading ? "Checking…" : problems > 0 ? (problems === 1 ? "1 thing needs attention" : `${problems} things need attention`) : "Needs attention"}
        actions={(
          <>
            <button
              type="button"
              className="ade-modern-btn"
              data-variant="ghost"
              disabled={loading || checking}
              onClick={() => void attention.reload({ force: true })}
            >
              <ArrowClockwise size={13} className={checking ? "animate-spin" : undefined} />
              {checking ? "Checking" : "Check again"}
            </button>
            {items.length > 0 && hasProject && !askOpen ? (
              <button type="button" className="ade-modern-btn" onClick={() => setAskOpen(true)}>
                <Robot size={13} />
                Ask an agent
              </button>
            ) : null}
          </>
        )}
      >
        {askOpen && items.length > 0 ? (
          <section className="kit-card">
            <header className="kit-card-head">
              <Robot size={14} />
              Ask an agent
              <span className="ade-health-card-hint">It explains each one and asks before changing anything.</span>
            </header>
            <div className="kit-card-body">
              <AgentLaunchSetup
                defaultPrompt={attentionAgentPrompt(items, projectRoot)}
                chatTitle="Fix what Settings found"
                promptLabel="Prompt for the agent"
                pin={null}
                projectRoot={projectRoot}
                onLaunched={() => setAskOpen(false)}
                onCancel={() => setAskOpen(false)}
                failureTitle="Couldn't start the agent"
              />
            </div>
          </section>
        ) : null}

        {loading ? (
          <ul className="ade-attn-list" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <li key={index} className="ade-attn-row"><span className="ade-st-shimmer" style={{ width: `${60 - index * 12}%` }} /></li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <div className="ade-modern-note" data-tone="ok">
            <CheckCircle size={14} weight="fill" />
            <span>Nothing needs attention.</span>
          </div>
        ) : (
          <>
            <ul className="ade-attn-list" aria-label="Needs attention">
              {shown.map((item) => {
                const busy = fixingId === item.id || (item.projectIssue?.fix != null && projectFix.fixingId === item.projectIssue.fix.id);
                const fixLabel = item.projectIssue?.fix?.label ?? item.fix?.label ?? null;
                return (
                  <li key={item.id} className="ade-attn-row" data-severity={item.severity}>
                    <span className="kit-dot" data-state={DOT_STATE[item.severity]} aria-hidden />
                    {/* Title over a one-line muted reason, then a fixed trailing
                        column on every row: scope chip, the fix button when
                        there is one, and the open arrow always, so chips and
                        arrows line up down the list. */}
                    <span className="ade-attn-text">
                      <span className="ade-attn-title">{item.title}</span>
                      {item.detail ? <span className="ade-attn-detail" title={item.detail}>{item.detail}</span> : null}
                    </span>
                    <span className="ade-attn-where-col"><span className="kit-tag ade-attn-where">{item.where}</span></span>
                    <span className="ade-attn-fix-col">
                      {fixLabel ? (
                        <button
                          type="button"
                          className="ade-modern-btn"
                          data-size="sm"
                          disabled={busy}
                          title={item.projectIssue?.fix?.description}
                          onClick={() => void runFix(item)}
                        >
                          {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                          {fixLabel}
                        </button>
                      ) : null}
                    </span>
                    {canOpen(item.route) ? (
                      <button
                        type="button"
                        className="kit-icon-btn ade-attn-open"
                        aria-label={`Open ${item.where} settings for: ${item.title}`}
                        title="Open its page"
                        onClick={() => navigate(item.route)}
                      >
                        <ArrowRight size={13} />
                      </button>
                    ) : <span aria-hidden />}
                  </li>
                );
              })}
            </ul>
            {hidden > 0 ? (
              <button type="button" className="ade-health-disclosure" onClick={() => setShowAll(true)}>
                <CaretDown size={11} weight="bold" className="ade-health-caret" />
                Show {hidden} more
              </button>
            ) : null}
          </>
        )}
      </ModernSection>

      <ModernSection group="Overview" anchor="at-a-glance" title="At a glance">
        <div className="ade-glance-grid">
          <ComputerCard sources={sources} onOpen={() => navigate(settingsRouteFor("storage.diagnostics").split("#")[0]!)} />
          {hasProject ? <ProjectCard sources={sources} onOpen={(route) => navigate(route)} /> : null}
          <AccountCard sources={sources} canOpen={canOpen} onOpen={(route) => navigate(route)} />
        </div>
      </ModernSection>
    </div>
  );
}

type Sources = ReturnType<typeof useNeedsAttention>["sources"];

function GlanceCard({
  icon,
  title,
  onOpen,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="kit-card ade-glance-card">
      <header className="kit-card-head">
        {icon}
        {title}
        <button type="button" className="kit-card-head-action" onClick={onOpen}>
          Open
          <ArrowRight size={11} />
        </button>
      </header>
      <div className="kit-card-body ade-glance-body">{children}</div>
    </section>
  );
}

function ComputerCard({ sources, onOpen }: { sources: Sources; onOpen: () => void }) {
  const runtime = sources.info?.localRuntime ?? null;
  const serviceOk = runtime ? runtime.connectionState === "connected" && runtime.runtimeMode === "primary" : null;
  const update = sources.update;
  const updateTag = update?.status === "ready"
    ? (update.version ? `${update.version} ready to install` : "Update ready")
    : update?.status === "downloading"
      ? "Downloading update"
      : null;
  const pressure = sources.pressure;
  const level = pressure ? freeSpaceLevel(pressure.freeBytes, pressure.totalBytes) : undefined;
  return (
    <GlanceCard icon={<Desktop size={14} />} title="This computer" onOpen={onOpen}>
      <div className="ade-glance-line">
        <span className="kit-dot" data-state={serviceOk == null ? undefined : serviceOk ? "ok" : "crit"} aria-hidden />
        <span>{serviceOk == null ? "Background service" : serviceOk ? "Service running" : "Service not running"}</span>
      </div>
      <div className="ade-glance-line">
        <span className="kit-num">ADE {sources.info?.appVersion ?? "—"}</span>
        {updateTag ? <span className="kit-tag" data-tone="ok">{updateTag}</span> : null}
      </div>
      {pressure && pressure.totalBytes > 0 ? (
        <div className="ade-glance-meter">
          <div className="ade-glance-meter-label">
            <span>Disk</span>
            <span className="kit-num">{formatBytes(pressure.freeBytes)} free</span>
          </div>
          <FreeSpaceMeter freeBytes={pressure.freeBytes} totalBytes={pressure.totalBytes} level={level} />
        </div>
      ) : null}
    </GlanceCard>
  );
}

/**
 * The open project: where it lives, its lanes as one small bar, and the space
 * ADE keeps for it. The lane list and storage are read after the first paint
 * (unpinned: the machine that owns the project), so the card never holds the
 * page back.
 */
function ProjectCard({ sources, onOpen }: { sources: Sources; onOpen: (route: string) => void }) {
  const theme = useChartTheme();
  const projectName = useAppStore((state) => state.project?.displayName ?? null);
  // A project on another computer: its machine names its own disk "This Mac",
  // which would read as this computer here, so the line names the machine.
  const remoteName = useAppStore((state) => (state.projectBinding?.kind === "remote" ? state.projectBinding.runtimeName : null));
  const report = sources.report;
  const [archived, setArchived] = React.useState<number | null>(null);
  const [storage, setStorage] = React.useState<StorageSnapshot | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.ade.lanes?.list?.({ includeArchived: true })
        .then((lanes: LaneSummary[]) => {
          if (!cancelled) setArchived(lanes.filter((lane) => Boolean(lane.archivedAt)).length);
        })
        .catch(() => undefined);
      void window.ade.storage?.getSnapshot?.({})
        .then((snapshot) => {
          if (!cancelled) setStorage(snapshot);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const lanes = report?.lanes ?? [];
  const counts = { active: 0, changes: 0, stale: 0 };
  for (const lane of lanes) counts[laneBucket(lane)] += 1;
  const series = storage ? categorySeries(storage.categories, 3) : [];
  const drive = report?.drive ?? null;
  return (
    <GlanceCard icon={<FolderSimple size={14} />} title={projectName ?? "This project"} onOpen={() => onOpen(settingsRouteFor("lanes-git.lanes"))}>
      {drive ? (
        <button type="button" className="ade-glance-line ade-glance-link" onClick={() => onOpen(settingsRouteFor("general.project-location"))}>
          {drive.internal ? <HardDrive size={13} /> : <HardDrives size={13} />}
          <span>
            {remoteName
              ? drive.internal ? `On ${remoteName}` : `On ${remoteName}'s external drive ${drive.name}`
              : `${drive.internal ? "On" : "On external drive"} ${drive.name}`}
          </span>
        </button>
      ) : null}
      {lanes.length > 0 ? (
        <div className="ade-glance-meter">
          <div className="ade-glance-meter-label">
            <span>{lanes.length === 1 ? "1 lane" : `${lanes.length} lanes`}{archived ? ` · ${archived} archived` : ""}</span>
            {counts.stale > 0 ? <span className="kit-num" style={{ color: "var(--kit-warn)" }}>{counts.stale} stale</span> : null}
          </div>
          <CountBar
            ariaLabel="Lanes"
            height={6}
            parts={[
              { id: "active", label: "Active", count: counts.active, color: "color-mix(in srgb, var(--color-fg) 32%, transparent)" },
              { id: "changes", label: "With changes", count: counts.changes, color: "var(--color-accent)" },
              { id: "stale", label: "Stale", count: counts.stale, color: "var(--kit-warn)" },
            ]}
          />
        </div>
      ) : null}
      {storage ? (
        <button type="button" className="ade-glance-meter ade-glance-link" onClick={() => onOpen(settingsRouteFor("storage.usage"))}>
          <div className="ade-glance-meter-label">
            <span>ADE data</span>
            <span className="kit-num">{formatMeasuredBytes(storage.totalAdeBytes, storage.truncated)}</span>
          </div>
          <div className="usage-split-bar ade-health-bar" style={{ height: 6 }} role="img" aria-label={series.map((entry) => `${entry.label} ${formatMeasuredBytes(entry.bytes, entry.partial)}`).join(", ")}>
            {series.map((entry, index) => (
              <span key={entry.id} style={{ flexGrow: Math.max(entry.bytes, 1), flexBasis: 0, background: seriesColor(index, entry.id, theme) }} title={`${entry.label} · ${formatMeasuredBytes(entry.bytes, entry.partial)}`} />
            ))}
          </div>
        </button>
      ) : null}
    </GlanceCard>
  );
}

function AccountCard({
  sources,
  canOpen,
  onOpen,
}: {
  sources: Sources;
  canOpen: (route: string) => boolean;
  onOpen: (route: string) => void;
}) {
  const daily = sources.usage?.dailyUsage7d ?? null;
  const week = React.useMemo(() => {
    if (!daily) return null;
    const rows = Object.values(daily).filter((values): values is number[] => Array.isArray(values));
    if (rows.length === 0) return null;
    const length = Math.max(...rows.map((values) => values.length));
    const totals = Array.from({ length }, (_, index) => rows.reduce((sum, values) => sum + (values[index] ?? 0), 0));
    return { totals, sum: totals.reduce((sum, value) => sum + value, 0) };
  }, [daily]);
  const detected = sources.providers.filter((provider) => provider.runtimeDetected);
  const signedIn = detected.filter((provider) => provider.runtimeAvailable).length;
  const needSignIn = detected.length - signedIn;
  const providersRoute = settingsRouteFor("agents.providers");
  const providersLine = (
    <>
      <span className="kit-dot" data-state={needSignIn > 0 ? "warn" : detected.length > 0 ? "ok" : undefined} aria-hidden />
      <span>
        {detected.length === 0
          ? "No AI provider found here"
          : needSignIn > 0
            ? `${signedIn} signed in · ${needSignIn} need${needSignIn === 1 ? "s" : ""} sign-in`
            : `${signedIn} ${signedIn === 1 ? "provider" : "providers"} signed in`}
      </span>
    </>
  );
  return (
    <GlanceCard icon={<UserCircle size={14} />} title="You" onOpen={() => onOpen(settingsRouteFor("stats.usage"))}>
      <div className="ade-glance-meter">
        <div className="ade-glance-meter-label">
          <span>This week</span>
          <span className="kit-num">{week ? `${formatTokens(week.sum)} tokens` : "—"}</span>
        </div>
        {week && week.totals.length >= 2 ? (
          <UsageSparkline values={week.totals} height={26} label={`Tokens per day this week, ${formatTokens(week.sum)} in all`} />
        ) : null}
      </div>
      {canOpen(providersRoute) ? (
        <button type="button" className="ade-glance-line ade-glance-link" onClick={() => onOpen(providersRoute)}>
          {providersLine}
        </button>
      ) : (
        <div className="ade-glance-line">{providersLine}</div>
      )}
    </GlanceCard>
  );
}
