import React from "react";
import { useLocation } from "react-router-dom";
import { Archive, ArrowClockwise, GitBranch, HardDrives, SlidersHorizontal } from "@phosphor-icons/react";
import { ModernSection } from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useSettingsSearchAnchors } from "../settingsSearchContext";
import { decodeSettingsHash } from "../settingsHash";
import { ArchiveSection } from "../ArchiveSection";
import { SessionLifecycleSection } from "../SessionLifecycleSection";
import { ProjectSection } from "../ProjectSection";
import { LaneBehaviorSection } from "../LaneBehaviorSection";
import { PrChatTranscriptsSection } from "../PrChatTranscriptsSection";
import { LaneTemplatesSection } from "../LaneTemplatesSection";
import { HealthSpace } from "../health/HealthSpace";
import { HealthCleanups } from "../health/HealthCleanups";
import { ProjectIssueList, useProjectFix } from "../health/ProjectIssues";
import { issuesForPage } from "../health/healthModel";
import { useHealthData } from "../health/useHealthData";
import { formatMeasuredBytes } from "../storage/storageView";
import { relativeWhen } from "../../../lib/format";
import { isWebClientMode } from "../../../lib/webClientMode";
import { Banner } from "../../ui/notice";
import { LaneList } from "./LaneList";
import "../machineSettings.css";
import "../health/health.css";
import "./lanes.css";

type ViewId = "lanes" | "space" | "archive" | "rules";

type View = {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
  /** The manifest anchors drawn in this view, so links and search find it. */
  anchors: readonly string[];
};

const VIEWS: readonly View[] = [
  { id: "lanes", label: "Lanes", icon: <GitBranch size={13} weight="duotone" />, anchors: ["lane-list"] },
  { id: "space", label: "Space", icon: <HardDrives size={13} weight="duotone" />, anchors: ["storage", "storage-cleanups"] },
  { id: "archive", label: "Archive", icon: <Archive size={13} weight="duotone" />, anchors: ["archive"] },
  {
    id: "rules",
    label: "Rules",
    icon: <SlidersHorizontal size={13} weight="duotone" />,
    anchors: [
      "lane-storage-rules",
      "session-lifecycle",
      "project",
      "new-lane-base",
      "auto-rebase",
      "rebase-suggestions",
      "rebase-min-behind",
      "pr-chat-transcripts",
      "lane-templates",
    ],
  },
];

/** The hosted web client can reach only the archive and the lane rules. */
const WEB_VIEWS: ReadonlySet<ViewId> = new Set(["archive", "rules"]);

function viewForAnchor(anchor: string | null): ViewId | null {
  if (!anchor) return null;
  return VIEWS.find((view) => view.anchors.includes(anchor))?.id ?? null;
}

/**
 * Settings → Project → Lanes, as four views under one tab strip: the lanes
 * themselves (stale ones first, with a safe bulk archive), the space they and
 * ADE's data take, the archive, and the rules for how lanes start, settle and
 * get archived. One view shows at a time, so the page is never a long scroll
 * of folded sections; a link or a settings search that names a card switches
 * to the view that holds it.
 *
 * Remote machines: the page always acts on the machine that owns the project
 * (`useSettingsMachineScope().pin`), and so does every section in it.
 */
export function LanesSettingsPage() {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const location = useLocation();
  const searchAnchors = useSettingsSearchAnchors();
  const web = isWebClientMode();
  const data = useHealthData(pin, isThisMachine, web ? {} : { storage: true, report: true });
  const fix = useProjectFix(pin, data.setReport);
  const views = web ? VIEWS.filter((view) => WEB_VIEWS.has(view.id)) : VIEWS;

  const hashAnchor = location.hash ? decodeSettingsHash(location.hash) : null;
  const [view, setView] = React.useState<ViewId>(() => viewForAnchor(hashAnchor) ?? views[0]!.id);

  // A link that names a card shows its view, then lands on the card once the
  // view is drawn (and again once the lane list and storage have loaded and
  // moved it).
  React.useEffect(() => {
    const target = viewForAnchor(hashAnchor);
    if (target) setView(target);
  }, [hashAnchor]);
  const settled = !data.report.loading && !data.storage.loading;
  React.useEffect(() => {
    if (!hashAnchor || hashAnchor === "lane-list" || viewForAnchor(hashAnchor) !== view) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(hashAnchor)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hashAnchor, view, settled]);

  // A search with no match in this view moves to the first view that has one.
  React.useEffect(() => {
    if (!searchAnchors || searchAnchors.length === 0) return;
    const holds = (id: ViewId) => VIEWS.find((entry) => entry.id === id)!.anchors.some((anchor) => searchAnchors.includes(anchor));
    setView((current) => (holds(current) ? current : views.find((entry) => holds(entry.id))?.id ?? current));
  }, [searchAnchors, views]);

  const { report, loading: reportLoading, checking, error: reportError, available } = data.report;
  const laneIssues = issuesForPage(report, "lanes").filter((issue) => issue.id !== "stale-lanes");
  const laneCategory = data.storage.snapshot?.categories.find((category) => category.id === "lanes_worktrees") ?? null;
  const staleCount = report?.lanes?.filter((lane) => lane.stale).length ?? 0;
  const snapshot = data.storage.snapshot;
  const reloadAll = React.useCallback(() => {
    void data.loadReport({ force: true });
    void data.loadStorage({ force: true, silent: true });
  }, [data]);

  const badge = (id: ViewId): { text: string; tone?: "warn" } | null => {
    if (id === "lanes" && report?.lanes) return staleCount > 0 ? { text: `${staleCount} stale`, tone: "warn" } : { text: String(report.lanes.length) };
    if (id === "space" && snapshot) return { text: formatMeasuredBytes(snapshot.totalAdeBytes, snapshot.truncated) };
    return null;
  };

  const renderView = (id: ViewId): React.ReactNode => {
    switch (id) {
      case "lanes":
        return (
          <ModernSection
            group="Lanes"
            anchor="lane-list"
            title={report?.lanes ? (staleCount > 0 ? `${staleCount} of ${report.lanes.length} lanes look done` : "Your lanes") : "Your lanes"}
            hint={report
              ? [
                  `Stale once its PR merges or closes, or after ${report.staleAfterDays ?? 14} days idle.`,
                  laneCategory ? `Lane folders take ${formatMeasuredBytes(laneCategory.bytes, Boolean(laneCategory.partial))}.` : null,
                  `Checked ${relativeWhen(report.checkedAt)}.`,
                ].filter(Boolean).join(" ")
              : available ? "Every lane in this project, stale ones first." : "The lane list needs a newer ADE on this machine."}
            actions={available ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-variant="ghost"
                disabled={checking || reportLoading}
                onClick={reloadAll}
              >
                <ArrowClockwise size={13} className={checking ? "animate-spin" : undefined} />
                {checking ? "Checking" : "Check again"}
              </button>
            ) : undefined}
          >
            {reportError && !report ? (
              <Banner
                layout="inline"
                model={{
                  id: "lanes-report-error",
                  tone: "error",
                  title: "ADE couldn't read this project's lanes",
                  detail: reportError,
                  actions: [{ label: "Try again", onClick: () => void data.loadReport({ force: true }) }],
                }}
              />
            ) : null}
            <ProjectIssueList issues={laneIssues} fixingId={fix.fixingId} onFix={(issue) => void fix.runFix(issue)} />
            {reportLoading && !report ? (
              <div className="ade-lanes-skeleton" aria-busy="true">
                {[0, 1, 2, 3].map((index) => <span key={index} className="ade-st-shimmer" />)}
              </div>
            ) : report?.lanes ? (
              <LaneList
                lanes={report.lanes}
                staleAfterDays={report.staleAfterDays ?? 14}
                laneItems={laneCategory?.items ?? []}
                pin={pin}
                onChanged={reloadAll}
              />
            ) : report ? (
              <div className="ade-modern-muted">The lane list needs a newer ADE on the machine that owns this project.</div>
            ) : null}
          </ModernSection>
        );
      case "space":
        return (
          <>
            <HealthSpace data={data} />
            <HealthCleanups data={data} show="history" />
          </>
        );
      case "archive":
        return <ArchiveSection />;
      case "rules":
        return (
          <>
            {web ? null : <HealthCleanups data={data} show="rules" />}
            <SessionLifecycleSection />
            <ProjectSection />
            <LaneBehaviorSection />
            <PrChatTranscriptsSection />
            <LaneTemplatesSection />
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="ade-lanes-page">
      <div className="ade-lanes-tabs" role="tablist" aria-label="Lanes settings">
        {views.map((entry) => {
          const count = badge(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`lanes-tab-${entry.id}`}
              aria-selected={view === entry.id}
              aria-controls={`lanes-view-${entry.id}`}
              className="ade-lanes-tab"
              onClick={() => setView(entry.id)}
            >
              {entry.icon}
              {entry.label}
              {count ? <span className="ade-lanes-tab-badge kit-num" data-tone={count.tone}>{count.text}</span> : null}
              {/* Views not drawn still answer the settings search. */}
              {view === entry.id ? null : entry.anchors.map((anchor) => <span key={anchor} hidden data-settings-anchor={anchor} />)}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`lanes-view-${view}`}
        aria-labelledby={`lanes-tab-${view}`}
        className="ade-modern-sections"
      >
        {renderView(view)}
      </div>
    </div>
  );
}
