import React from "react";
import { useLocation } from "react-router-dom";
import {
  Archive,
  ArrowClockwise,
  Broom,
  CaretDown,
  GitBranch,
  HardDrives,
  Rocket,
  Timer,
} from "@phosphor-icons/react";
import { ModernSection, SettingsSectionRail } from "../primitives";
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
import { relativeWhen } from "../../../lib/format";
import { isWebClientMode } from "../../../lib/webClientMode";
import { Banner } from "../../ui/notice";
import { LaneList } from "./LaneList";
import "../machineSettings.css";
import "../health/health.css";
import "./lanes.css";

type BlockId = "lanes" | "storage" | "archive" | "cleanups" | "sessions" | "start";

type Block = {
  id: BlockId;
  title: string;
  icon: React.ReactNode;
  /** Collapsed until opened, a link names one of its cards, or a search matches one. */
  collapsible?: { hint: string; anchors: readonly string[] };
};

const BLOCKS: readonly Block[] = [
  { id: "lanes", title: "Lanes", icon: <GitBranch size={14} weight="duotone" /> },
  { id: "storage", title: "Storage", icon: <HardDrives size={14} weight="duotone" /> },
  {
    id: "archive",
    title: "Archive",
    icon: <Archive size={14} weight="duotone" />,
    collapsible: { hint: "Archived lanes, chats and shells. Restore or delete them.", anchors: ["archive"] },
  },
  { id: "cleanups", title: "Cleanups", icon: <Broom size={14} weight="duotone" /> },
  {
    id: "sessions",
    title: "Sessions",
    icon: <Timer size={14} weight="duotone" />,
    collapsible: { hint: "When finished lane work settles, and repairing the .ade folder.", anchors: ["session-lifecycle", "project"] },
  },
  {
    id: "start",
    title: "How lanes start",
    icon: <Rocket size={14} weight="duotone" />,
    collapsible: {
      hint: "Where new lanes branch from, rebasing, PR transcripts and templates.",
      anchors: ["new-lane-base", "auto-rebase", "rebase-suggestions", "rebase-min-behind", "pr-chat-transcripts", "lane-templates"],
    },
  },
];

/** The hosted web client can reach only the archive and the lane rules. */
const WEB_BLOCKS: ReadonlySet<BlockId> = new Set(["archive", "start"]);

function blockId(id: BlockId): string {
  return `settings-group-lanes-${id}`;
}

/**
 * Settings → Project → Lanes: every lane in the project with its state, then
 * the space lanes and ADE's data take (Clean up safely), the archive, the
 * cleanup history and rules, sessions, and how new lanes start. A sticky rail
 * names each block; the long and rarely used ones open on demand, so the page
 * reads top-down as list → space → rules.
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
  const blocks = web ? BLOCKS.filter((block) => WEB_BLOCKS.has(block.id)) : BLOCKS;

  const hashAnchor = location.hash ? decodeSettingsHash(location.hash) : null;
  const [open, setOpen] = React.useState<ReadonlySet<BlockId>>(() => new Set(
    BLOCKS.filter((block) => block.collapsible && hashAnchor && block.collapsible.anchors.includes(hashAnchor)).map((block) => block.id),
  ));
  const pendingScroll = React.useRef<string | null>(null);

  // A link that names a card in a closed block opens the block, then scrolls
  // to the card once it is drawn.
  React.useEffect(() => {
    if (!hashAnchor) return;
    const block = BLOCKS.find((entry) => entry.collapsible?.anchors.includes(hashAnchor));
    if (!block) return;
    setOpen((current) => {
      if (current.has(block.id)) return current;
      pendingScroll.current = hashAnchor;
      return new Set([...current, block.id]);
    });
  }, [hashAnchor]);

  // A search that matches a card in a closed block opens it, so the match shows.
  React.useEffect(() => {
    if (!searchAnchors || searchAnchors.length === 0) return;
    const matched = BLOCKS.filter((block) => block.collapsible?.anchors.some((anchor) => searchAnchors.includes(anchor)));
    if (matched.length === 0) return;
    setOpen((current) => (matched.every((block) => current.has(block.id)) ? current : new Set([...current, ...matched.map((block) => block.id)])));
  }, [searchAnchors]);

  React.useEffect(() => {
    const target = pendingScroll.current;
    if (!target) return;
    pendingScroll.current = null;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // The lane list and storage load after the page opens and push everything
  // below them down, so a link to a card further down lands once more when
  // they are in.
  const settled = !data.report.loading && !data.storage.loading;
  const relandedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!settled || !hashAnchor || relandedFor.current === hashAnchor) return;
    relandedFor.current = hashAnchor;
    if (hashAnchor === "lane-list") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(hashAnchor)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hashAnchor, settled]);

  const toggle = (id: BlockId) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Picking a closed block in the rail opens it and scrolls to it once it is
  // drawn; scrolling before that stops short near the end of the page.
  const openFromRail = React.useCallback((id: string): boolean => {
    const block = BLOCKS.find((entry) => blockId(entry.id) === id);
    if (!block?.collapsible || open.has(block.id)) return false;
    pendingScroll.current = id;
    setOpen((current) => new Set([...current, block.id]));
    return true;
  }, [open]);

  const { report, loading: reportLoading, checking, error: reportError, available } = data.report;
  const laneIssues = issuesForPage(report, "lanes").filter((issue) => issue.id !== "stale-lanes");
  const laneCategory = data.storage.snapshot?.categories.find((category) => category.id === "lanes_worktrees") ?? null;
  const staleCount = report?.lanes?.filter((lane) => lane.stale).length ?? 0;
  const reloadAll = React.useCallback(() => {
    void data.loadReport({ force: true });
    void data.loadStorage({ force: true, silent: true });
  }, [data]);

  const renderBlock = (block: Block): React.ReactNode => {
    switch (block.id) {
      case "lanes":
        return (
          <ModernSection
            group="Lanes"
            anchor="lane-list"
            title={report?.lanes ? (staleCount > 0 ? `${staleCount} of ${report.lanes.length} lanes look done` : "Your lanes") : "Your lanes"}
            hint={report
              ? `Stale once its PR merges or closes, or after ${report.staleAfterDays ?? 14} days idle. Checked ${relativeWhen(report.checkedAt)}.`
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
                totalBytes={laneCategory ? { bytes: laneCategory.bytes, partial: Boolean(laneCategory.partial) } : null}
                pin={pin}
                onChanged={reloadAll}
              />
            ) : report ? (
              <div className="ade-modern-muted">The lane list needs a newer ADE on the machine that owns this project.</div>
            ) : null}
          </ModernSection>
        );
      case "storage":
        return <HealthSpace data={data} />;
      case "archive":
        return <ArchiveSection />;
      case "cleanups":
        return <HealthCleanups data={data} />;
      case "sessions":
        return (
          <>
            <SessionLifecycleSection />
            <ProjectSection />
          </>
        );
      case "start":
        return (
          <>
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
    <div className="ade-settings-layout">
      <SettingsSectionRail
        entries={blocks.map((block) => ({ id: blockId(block.id), title: block.title, icon: block.icon }))}
        onSelect={openFromRail}
      />
      <div className="ade-settings-flow">
        {blocks.map((block) => {
          const collapsed = block.collapsible && !open.has(block.id);
          return (
            <section
              key={block.id}
              id={blockId(block.id)}
              className="ade-settings-group-block"
              data-settings-group={block.title}
            >
              {block.collapsible ? (
                <button
                  type="button"
                  className="ade-lanes-block-toggle"
                  aria-expanded={!collapsed}
                  onClick={() => toggle(block.id)}
                >
                  <CaretDown size={12} weight="bold" className="ade-health-caret" data-open={!collapsed || undefined} />
                  <span className="ade-settings-group-title">{block.title}</span>
                  {collapsed ? <span className="ade-lanes-block-hint">{block.collapsible.hint}</span> : null}
                  {/* While closed, the block still answers the settings search. */}
                  {collapsed ? block.collapsible.anchors.map((anchor) => (
                    <span key={anchor} hidden data-settings-anchor={anchor} />
                  )) : null}
                </button>
              ) : (
                <header className="ade-settings-group-head">
                  <h2 className="ade-settings-group-title">{block.title}</h2>
                </header>
              )}
              {collapsed ? null : <div className="ade-settings-flow-item">{renderBlock(block)}</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
