import React from "react";
import { Archive, ArrowClockwise, ArrowSquareOut, CaretDown, CheckCircle, PushPin } from "@phosphor-icons/react";
import type { ProjectLaneHealth } from "../../../../shared/types/projectHealth";
import type { StorageItem } from "../../../../shared/types/storage";
import type { OpenProjectBinding } from "../../../../shared/types";
import { confirmDialog } from "../../ui/dialog";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import { formatBytes, formatMeasuredBytes } from "../storage/storageView";
import { useLaneReclaim } from "./useLaneReclaim";
import {
  laneBulkArchiveSkipReason,
  LANE_FILTERS,
  laneFilterMatches,
  laneNotSelectableReason,
  laneStaleReason,
  laneStatusPill,
  sortLanes,
  type LaneFilter,
} from "./laneListModel";

const ARCHIVE_TOAST_ID = "settings-lanes-archive";
/** Rows shown before "Show N more". */
const INITIAL_ROWS = 12;

type LaneSize = { bytes: number; partial: boolean };

/** Each lane's folder size from the storage snapshot, by lane id or folder. */
function sizeIndex(items: readonly StorageItem[]): { byId: Map<string, LaneSize>; byPath: Map<string, LaneSize> } {
  const byId = new Map<string, LaneSize>();
  const byPath = new Map<string, LaneSize>();
  for (const item of items) {
    const size = { bytes: item.bytes, partial: Boolean(item.partial) };
    if (item.laneId) byId.set(item.laneId, size);
    if (item.path) byPath.set(item.path, size);
  }
  return { byId, byPath };
}

/**
 * Project → Lanes, the list: every lane with its status, PR, last activity and
 * size, stale lanes first. Stale lanes that lose nothing when archived can be
 * selected and archived together; the rest go one at a time through the
 * existing archive confirm, which shows what would be lost.
 *
 * Every call goes to the machine that owns the project (`pin`).
 */
export function LaneList({
  lanes,
  staleAfterDays,
  laneItems,
  pin,
  onChanged,
}: {
  lanes: readonly ProjectLaneHealth[];
  staleAfterDays: number;
  laneItems: readonly StorageItem[];
  pin: OpenProjectBinding | null;
  onChanged: () => void;
}) {
  const [filter, setFilter] = React.useState<LaneFilter>("all");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const reclaim = useLaneReclaim(pin, onChanged);

  const sizes = React.useMemo(() => sizeIndex(laneItems), [laneItems]);
  const sizeOf = React.useCallback(
    (lane: ProjectLaneHealth): LaneSize | null => sizes.byId.get(lane.laneId) ?? sizes.byPath.get(lane.worktreePath) ?? null,
    [sizes],
  );
  const sorted = React.useMemo(() => sortLanes(lanes), [lanes]);
  // Each tile counts exactly the lanes its filter shows.
  const counts = React.useMemo(
    () => Object.fromEntries(LANE_FILTERS.map((option) => [option.id, lanes.filter((lane) => laneFilterMatches(lane, option.id)).length])) as Record<LaneFilter, number>,
    [lanes],
  );
  const filtered = sorted.filter((lane) => laneFilterMatches(lane, filter));
  const visible = showAll ? filtered : filtered.slice(0, INITIAL_ROWS);
  const hidden = filtered.length - visible.length;

  // A lane that left the list (archived elsewhere, or by this page) drops out
  // of the selection too.
  React.useEffect(() => {
    setSelected((current) => {
      const live = new Set(lanes.filter((lane) => laneNotSelectableReason(lane) == null).map((lane) => lane.laneId));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [lanes]);

  const selectedLanes = lanes.filter((lane) => selected.has(lane.laneId));
  const selectedBytes = selectedLanes.reduce((sum, lane) => sum + (sizeOf(lane)?.bytes ?? 0), 0);
  const selectableStale = lanes.filter((lane) => lane.stale && laneNotSelectableReason(lane) == null);

  const toggle = (laneId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  };

  const archiveSelected = async () => {
    if (selectedLanes.length === 0 || archiving) return;
    const count = selectedLanes.length;
    const confirmed = await confirmDialog({
      title: count === 1 ? `Archive ${selectedLanes[0]!.name}?` : `Archive ${count} lanes?`,
      message: `${selectedBytes > 0 ? `Frees about ${formatBytes(selectedBytes)}. ` : ""}Their folders are removed; branches, chats and history are kept. You can restore any of them from the archive below.`,
      confirmLabel: count === 1 ? "Archive lane" : `Archive ${count} lanes`,
    });
    if (!confirmed) return;
    setArchiving(true);
    const archived: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    let freed = 0;
    try {
      // The merged-PR exception reads the lane's git state, so read it again
      // now: a lane can have picked up commits since the list was drawn. When
      // the fresh read fails, no lane gets the exception.
      const fresh = await window.ade.projectHealth.getReport({ forceRefresh: true }, pin)
        .then((report) => new Map((report.lanes ?? []).map((lane) => [lane.laneId, lane])))
        .catch(() => null);
      // One at a time, each checked again right before it goes: a lane may
      // have picked up changes or a running chat since the list was read.
      for (const lane of selectedLanes) {
        try {
          const risk = await window.ade.lanes.getReclaimRisk({ laneId: lane.laneId }, pin);
          const skipReason = laneBulkArchiveSkipReason(fresh?.get(lane.laneId) ?? { ...lane, pr: null }, risk);
          if (skipReason) {
            skipped.push(`${lane.name}: ${skipReason}`);
            continue;
          }
          const result = await window.ade.lanes.archiveAndReclaim({ laneId: lane.laneId, confirmation: "RECLAIM" }, pin);
          freed += result.reclaimedBytes;
          archived.push(lane.name);
        } catch (err) {
          failed.push(`${lane.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      setArchiving(false);
      setSelected(new Set());
    }
    const lines = [
      ...skipped.map((line) => `Skipped ${line}`),
      ...failed.map((line) => `Failed ${line}`),
    ];
    showToast({
      id: ARCHIVE_TOAST_ID,
      tone: archived.length === 0 ? (failed.length > 0 ? "error" : "warning") : lines.length > 0 ? "warning" : "success",
      title: archived.length === 0
        ? "No lanes were archived"
        : `Archived ${archived.length === 1 ? archived[0] : `${archived.length} lanes`}${freed > 0 ? `, freed ${formatBytes(freed)}` : ""}`,
      message: lines.length > 0 ? lines.join("\n") : "Branches and chats were kept.",
      durationMs: lines.length > 0 ? READABLE_TOAST_DURATION_MS : undefined,
    });
    onChanged();
  };

  if (lanes.length === 0) {
    return <div className="ade-modern-muted">No lanes yet.</div>;
  }

  return (
    <div className="ade-lanes">
      <div className="ade-lanes-toolbar">
        <div className="ade-lanes-tiles" role="group" aria-label="Show lanes">
          {LANE_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="ade-lanes-tile"
              data-tone={option.id === "stale" && counts.stale > 0 ? "warn" : undefined}
              aria-pressed={filter === option.id}
              onClick={() => {
                setFilter(option.id);
                setShowAll(false);
              }}
            >
              <span className="ade-lanes-tile-count kit-num">{counts[option.id]}</span>
              <span className="ade-lanes-tile-label">{option.label}</span>
            </button>
          ))}
        </div>
        <div className="ade-lanes-toolbar-actions">
          {selected.size === 0 && selectableStale.length > 0 ? (
            <button
              type="button"
              className="ade-modern-btn"
              data-size="sm"
              title="Stale lanes with nothing to lose. The others need a look first (Archive…)."
              onClick={() => setSelected(new Set(selectableStale.map((lane) => lane.laneId)))}
            >
              Select {selectableStale.length} safe to archive
            </button>
          ) : null}
          {selected.size > 0 ? (
            <>
              <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button
                type="button"
                className="ade-modern-btn"
                data-tone="primary"
                disabled={archiving}
                onClick={() => void archiveSelected()}
              >
                {archiving ? <ArrowClockwise size={13} className="animate-spin" /> : <Archive size={13} />}
                {`Archive ${selected.size === 1 ? "1 lane" : `${selected.size} lanes`}${selectedBytes > 0 ? ` · frees ${formatBytes(selectedBytes)}` : ""}`}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="ade-modern-note" data-tone="ok">
          <CheckCircle size={14} weight="fill" />
          <span>{filter === "stale" ? "No stale lanes." : filter === "changes" ? "No lane has unsaved work." : "Nothing is running."}</span>
        </div>
      ) : (
        <ul className="ade-lanes-list" aria-label="Lanes">
          {/* Column names for the right-hand values; visual only, each row's
              cells already say what they are to a screen reader. */}
          <li className="ade-lanes-headrow" aria-hidden>
            <span />
            <span>Lane</span>
            <span>PR</span>
            <span className="ade-lanes-when">Updated</span>
            <span className="ade-lanes-size">Size</span>
            <span />
          </li>
          {visible.map((lane) => (
            <LaneRow
              key={lane.laneId}
              lane={lane}
              size={sizeOf(lane)}
              staleAfterDays={staleAfterDays}
              selected={selected.has(lane.laneId)}
              open={expanded === lane.laneId}
              onToggleOpen={() => setExpanded((current) => (current === lane.laneId ? null : lane.laneId))}
              onToggleSelect={() => toggle(lane.laneId)}
              onArchive={() => void reclaim.open(lane.laneId)}
            />
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <button type="button" className="ade-health-disclosure" onClick={() => setShowAll(true)}>
          <CaretDown size={11} weight="bold" className="ade-health-caret" />
          Show {hidden} more
        </button>
      ) : null}
      {reclaim.dialog}
    </div>
  );
}

function LaneRow({
  lane,
  size,
  staleAfterDays,
  selected,
  open,
  onToggleOpen,
  onToggleSelect,
  onArchive,
}: {
  lane: ProjectLaneHealth;
  size: LaneSize | null;
  staleAfterDays: number;
  selected: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleSelect: () => void;
  onArchive: () => void;
}) {
  const primary = lane.laneType === "primary";
  const blockedReason = laneNotSelectableReason(lane);
  const pill = laneStatusPill(lane);
  const detailsId = `lane-row-details-${lane.laneId}`;
  return (
    <li className="ade-lanes-row" data-stale={lane.stale ? "true" : undefined} data-open={open || undefined}>
      <div className="ade-lanes-row-main">
        <span className="ade-lanes-check">
          {primary ? (
            <PushPin size={13} weight="fill" aria-label="Primary lane" />
          ) : (
            <input
              type="checkbox"
              checked={selected}
              disabled={blockedReason != null}
              title={blockedReason ?? `Select ${lane.name}`}
              aria-label={blockedReason ? `${lane.name}: ${blockedReason}` : `Select ${lane.name}`}
              onChange={onToggleSelect}
            />
          )}
        </span>
        <button
          type="button"
          className="ade-lanes-row-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggleOpen}
        >
          <span className="ade-lanes-name" title={lane.name}>{lane.name}</span>
          <span className="kit-tag" data-tone={pill.tone}>{pill.label}</span>
          {lane.runningSessions > 0 ? (
            <span className="kit-tag ade-lanes-running"><span className="kit-dot" data-state="accent" aria-hidden />Running</span>
          ) : null}
          {lane.stale && lane.dirty ? <span className="kit-tag" data-tone="warn">Changes</span> : null}
          {lane.stale && (lane.unpushedCommits ?? 0) > 0 ? <span className="kit-tag" data-tone="warn">Unpushed</span> : null}
        </button>
        <span className="ade-lanes-pr">
          {lane.pr ? (
            <span className="ade-lanes-pr-chip" data-state={lane.pr.state}>#{lane.pr.number} {lane.pr.state}</span>
          ) : null}
        </span>
        <span className="ade-lanes-when kit-num">{lane.lastActivityAt ? relativeWhen(lane.lastActivityAt) : "—"}</span>
        <span className="ade-lanes-size kit-num">{primary ? "" : size ? formatMeasuredBytes(size.bytes, size.partial) : "—"}</span>
        <span className="ade-lanes-action">
          {!primary && blockedReason != null && lane.runningSessions === 0 ? (
            <button type="button" className="ade-modern-btn" data-size="sm" title="Shows what would be lost first" onClick={onArchive}>
              Archive…
            </button>
          ) : null}
        </span>
      </div>
      {open ? (
        <div className="ade-lanes-row-details" id={detailsId}>
          <dl className="ade-modern-facts">
            {lane.stale ? (
              <>
                <dt>Why stale</dt>
                <dd>{laneStaleReason(lane, staleAfterDays)}</dd>
              </>
            ) : null}
            <dt>Branch</dt>
            <dd className="ade-modern-path">{lane.branch ?? "No branch"}</dd>
            <dt>Folder</dt>
            <dd className="ade-modern-path" title={lane.worktreePath}>
              {lane.worktreePath}
              {lane.folderExists ? "" : " (missing)"}
            </dd>
            {lane.dirty != null || lane.unpushedCommits != null ? (
              <>
                <dt>Unsaved work</dt>
                <dd>
                  {[
                    lane.dirty ? `${lane.changedFileCount ?? "Some"} changed ${lane.changedFileCount === 1 ? "file" : "files"}` : null,
                    (lane.unpushedCommits ?? 0) > 0 ? `${lane.unpushedCommits} unpushed ${lane.unpushedCommits === 1 ? "commit" : "commits"}` : null,
                    lane.runningSessions > 0 ? `${lane.runningSessions} running ${lane.runningSessions === 1 ? "chat or terminal" : "chats or terminals"}` : null,
                  ].filter(Boolean).join(" · ") || "None"}
                </dd>
              </>
            ) : null}
            {lane.pr ? (
              <>
                <dt>Pull request</dt>
                <dd>
                  {lane.pr.url ? (
                    <button
                      type="button"
                      className="ade-modern-btn"
                      data-variant="link"
                      onClick={() => void window.ade.app.openExternal(lane.pr!.url!)}
                    >
                      #{lane.pr.number} {lane.pr.state}
                      <ArrowSquareOut size={11} style={{ marginLeft: 4 }} />
                    </button>
                  ) : `#${lane.pr.number} ${lane.pr.state}`}
                  {lane.pr.mergedAt ? <span className="ade-modern-muted"> · merged {relativeWhen(lane.pr.mergedAt)}</span> : null}
                </dd>
              </>
            ) : null}
          </dl>
          {!primary ? (
            <div>
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={onArchive}>
                <Archive size={12} />
                Archive…
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
