import React from "react";
import { CaretRight, Pause, Play, SkipForward, ArrowsDownUp, Trash, GithubLogo, CheckCircle, XCircle, Circle } from "@phosphor-icons/react";
import type {
  LandResult,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrSummary,
  PrWithConflicts,
  QueueEntryState,
  QueueLandingState,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { PrRebaseBanner } from "../PrRebaseBanner";
import { usePrs } from "../state/PrsContext";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

type QueueGroup = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  members: Array<{ prId: string; laneId: string; laneName: string; position: number; pr: PrWithConflicts | null }>;
  landingState: QueueLandingState | null;
};

function entryStateChip(state: QueueEntryState): { label: string; className: string; pulse?: boolean } {
  switch (state) {
    case "landed": return { label: "landed", className: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" };
    case "landing": return { label: "landing", className: "text-blue-300 border-blue-500/30 bg-blue-500/10", pulse: true };
    case "rebasing": return { label: "rebasing", className: "text-amber-300 border-amber-500/30 bg-amber-500/10", pulse: true };
    case "resolving": return { label: "resolving", className: "text-violet-300 border-violet-500/30 bg-violet-500/10", pulse: true };
    case "failed": return { label: "failed", className: "text-red-300 border-red-500/30 bg-red-500/10" };
    case "paused": return { label: "paused", className: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
    case "skipped": return { label: "skipped", className: "text-neutral-300 border-neutral-500/30 bg-neutral-500/10" };
    default: return { label: "pending", className: "text-neutral-300 border-neutral-500/30 bg-neutral-500/10" };
  }
}

/* ---------- Status badge for queue group list items ---------- */
function GroupStatusBadge({ members }: { members: QueueGroup["members"] }) {
  const hasOpen = members.some((m) => m.pr?.state === "open" || m.pr?.state === "draft");
  if (hasOpen) {
    return (
      <span
        className="font-mono text-[10px] font-bold uppercase tracking-[1px] px-1.5 py-0.5"
        style={{ color: "#22C55E", background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)" }}
      >
        ONLINE
      </span>
    );
  }
  return (
    <span
      className="font-mono text-[10px] font-bold uppercase tracking-[1px] px-1.5 py-0.5"
      style={{ color: "#71717A", background: "rgba(113,113,122,0.10)", border: "1px solid rgba(113,113,122,0.25)" }}
    >
      OFFLINE
    </span>
  );
}

function ChecksBadge({ status }: { status: PrSummary["checksStatus"] | undefined }) {
  if (!status || status === "none") return null;
  const config =
    status === "passing"
      ? { color: "#22C55E", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.25)", icon: <CheckCircle size={11} weight="fill" style={{ color: "#22C55E" }} /> }
      : status === "failing"
        ? { color: "#EF4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)", icon: <XCircle size={11} weight="fill" style={{ color: "#EF4444" }} /> }
        : { color: "#F59E0B", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)", icon: <Circle size={11} weight="fill" style={{ color: "#F59E0B" }} /> };
  return (
    <span
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{
        fontSize: 10,
        color: config.color,
        background: config.bg,
        border: `1px solid ${config.border}`,
        padding: "2px 6px",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {config.icon}
      CI
    </span>
  );
}

type QueueTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function QueueTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedGroupId, onSelectGroup, onRefresh }: QueueTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const prById = React.useMemo(() => new Map(prs.map((p) => [p.id, p])), [prs]);
  const { rebaseNeeds, autoRebaseStatuses, setActiveTab } = usePrs();

  const [landBusy, setLandBusy] = React.useState(false);
  const [landError, setLandError] = React.useState<string | null>(null);
  const [landResult, setLandResult] = React.useState<LandResult | null>(null);
  const [archiveOnLand, setArchiveOnLand] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  // Build queue groups from merge contexts
  const queueGroups = React.useMemo(() => {
    const groupMap = new Map<string, QueueGroup>();
    for (const pr of prs) {
      const ctx = mergeContextByPrId[pr.id];
      if (!ctx?.groupId || ctx.groupType !== "queue") continue;
      let group = groupMap.get(ctx.groupId);
      if (!group) {
        group = { groupId: ctx.groupId, name: null, targetBranch: null, members: [], landingState: null };
        groupMap.set(ctx.groupId, group);
      }
      const member = ctx.members?.find((m) => m.prId === pr.id);
      group.members.push({
        prId: pr.id,
        laneId: pr.laneId,
        laneName: laneById.get(pr.laneId)?.name ?? pr.laneId,
        position: member?.position ?? group.members.length,
        pr,
      });
    }
    // Sort members by position within each group
    for (const group of groupMap.values()) {
      group.members.sort((a, b) => a.position - b.position);
    }
    return [...groupMap.values()];
  }, [prs, mergeContextByPrId, laneById]);

  const selectedGroup = React.useMemo(() => queueGroups.find((g) => g.groupId === selectedGroupId) ?? null, [queueGroups, selectedGroupId]);

  // Auto-select first group (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (queueGroups.length === 0 && selectedGroupId === null) return;
    if (selectedGroupId && queueGroups.some((g) => g.groupId === selectedGroupId)) return;
    onSelectGroup(queueGroups[0]?.groupId ?? null);
  }, [queueGroups, selectedGroupId, onSelectGroup]);

  const handleLandNext = async () => {
    if (!selectedGroup) return;
    setLandBusy(true); setLandError(null); setLandResult(null);
    try {
      const result = await window.ade.prs.landQueueNext({ groupId: selectedGroup.groupId, method: mergeMethod, archiveLane: archiveOnLand });
      setLandResult(result);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setLandBusy(false); }
  };

  const handleDeletePr = async (prId: string) => {
    setDeleteBusy(true); setLandError(null);
    try {
      await window.ade.prs.delete({ prId, closeOnGitHub: deleteCloseGh });
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  /* ---------- Stat counters for selected group ---------- */
  const stats = React.useMemo(() => {
    if (!selectedGroup) return { landed: 0, pending: 0, failed: 0, processing: false };
    let landed = 0, pending = 0, failed = 0, processing = false;
    for (const m of selectedGroup.members) {
      const st = m.pr?.state;
      if (st === "merged") landed++;
      else if (st === "closed") failed++;
      else { pending++; if (st === "open") processing = true; }
    }
    return { landed, pending, failed, processing };
  }, [selectedGroup]);

  const pad2 = (n: number) => String(n).padStart(2, "0");

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Queue Groups",
      bodyClassName: "overflow-auto",
      children: (
        <div style={{ padding: 8 }}>
          {/* Section header */}
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{ fontSize: 10, color: "#71717A", padding: "8px 8px 12px" }}
          >
            QUEUE GROUPS
          </div>

          {!queueGroups.length ? (
            <EmptyState title="No queue groups" description="Create a queue to open sequential PRs across lanes for ordered landing." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {queueGroups.map((group) => {
                const isSelected = group.groupId === selectedGroupId;
                const openCount = group.members.filter((m) => m.pr?.state === "open" || m.pr?.state === "draft").length;
                const landedCount = group.members.filter((m) => m.pr?.state === "merged").length;
                return (
                  <button
                    key={group.groupId}
                    type="button"
                    className="w-full text-left font-mono transition-colors duration-100"
                    style={{
                      padding: "12px 12px 12px 14px",
                      borderLeft: isSelected ? "3px solid #A78BFA" : "3px solid transparent",
                      background: isSelected ? "rgba(167,139,250,0.07)" : "transparent",
                      borderRadius: 0,
                    }}
                    onClick={() => onSelectGroup(group.groupId)}
                    onMouseEnter={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = "rgba(167,139,250,0.04)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span className="font-bold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                        {group.name ?? `Queue ${group.groupId.slice(0, 8)}`}
                      </span>
                      <GroupStatusBadge members={group.members} />
                    </div>
                    <div
                      className="font-mono"
                      style={{ marginTop: 6, fontSize: 11, color: "#71717A", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span>{group.members.length} PRs</span>
                      <span style={{ color: "#52525B" }}>&middot;</span>
                      <span>target: {group.targetBranch ?? "main"}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    detail: {
      title: selectedGroup ? `Queue: ${selectedGroup.name ?? selectedGroup.groupId.slice(0, 8)}` : "Queue Detail",
      bodyClassName: "overflow-auto",
      children: selectedGroup ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20 }}>

          {/* ===== Rebase banners for member lanes ===== */}
          {selectedGroup.members.map((m) => (
            <PrRebaseBanner key={m.laneId} laneId={m.laneId} rebaseNeeds={rebaseNeeds} autoRebaseStatuses={autoRebaseStatuses} onTabChange={(tab) => setActiveTab(tab as "normal" | "queue" | "integration" | "rebase")} />
          ))}

          {/* ===== Header card ===== */}
          <div
            style={{
              background: "#13101A",
              border: "1px solid #1E1B26",
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div className="font-bold" style={{ fontSize: 16, color: "#FAFAFA", fontFamily: "'Space Grotesk', sans-serif" }}>
                {selectedGroup.name ?? `Queue ${selectedGroup.groupId.slice(0, 8)}`}
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                {selectedGroup.members.length} PRs in pipeline
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label
                style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#71717A", cursor: "pointer" }}
                className="font-mono"
              >
                <input
                  type="checkbox"
                  checked={archiveOnLand}
                  onChange={(e) => setArchiveOnLand(e.target.checked)}
                  style={{ accentColor: "#A78BFA" }}
                />
                Archive lane
              </label>
              <button
                type="button"
                disabled={landBusy}
                onClick={() => void handleLandNext()}
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 11,
                  background: "#A78BFA",
                  color: "#0F0D14",
                  border: "none",
                  padding: "8px 16px",
                  cursor: landBusy ? "not-allowed" : "pointer",
                  opacity: landBusy ? 0.4 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <ArrowsDownUp size={13} weight="bold" />
                {landBusy ? "LANDING..." : "LAND NEXT"}
              </button>
            </div>
          </div>

          {/* ===== Queue Status section ===== */}
          <div>
            <div
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
            >
              QUEUE STATUS
            </div>
            <div
              style={{
                background: "#13101A",
                border: "1px solid #1E1B26",
                padding: 16,
              }}
            >
              {/* Processing indicator */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                {stats.processing ? (
                  <>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        background: "#22C55E",
                        display: "inline-block",
                        animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                      }}
                    />
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 11, color: "#22C55E" }}>
                      PROCESSING
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ width: 8, height: 8, background: "#71717A", display: "inline-block" }} />
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 11, color: "#71717A" }}>
                      IDLE
                    </span>
                  </>
                )}
              </div>

              {/* Stat counters */}
              <div style={{ display: "flex", gap: 24 }}>
                {/* LANDED */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#22C55E", lineHeight: 1 }}>
                    {pad2(stats.landed)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    LANDED
                  </span>
                </div>
                {/* PENDING */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#A1A1AA", lineHeight: 1 }}>
                    {pad2(stats.pending)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    PENDING
                  </span>
                </div>
                {/* FAILED */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#EF4444", lineHeight: 1 }}>
                    {pad2(stats.failed)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    FAILED
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ===== Members / Pipeline section ===== */}
          <div>
            <div
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
            >
              MEMBERS
            </div>
            <div
              style={{
                background: "#13101A",
                border: "1px solid #1E1B26",
                padding: 16,
              }}
            >
              {selectedGroup.members.map((member, idx) => {
                const isLast = idx === selectedGroup.members.length - 1;
                const prState = member.pr?.state ?? "unknown";
                const isLanded = prState === "merged";
                const isActive = prState === "open";
                const isFailed = prState === "closed";

                // Dot color
                const dotColor = isLanded ? "#22C55E" : isActive ? "#3B82F6" : isFailed ? "#EF4444" : "#52525B";

                // Status badge text + colors
                let badgeLabel = "PENDING";
                let badgeColor = "#A1A1AA";
                let badgeBg = "rgba(161,161,170,0.08)";
                let badgeBorder = "rgba(161,161,170,0.20)";
                if (isLanded) {
                  badgeLabel = "LANDED";
                  badgeColor = "#22C55E";
                  badgeBg = "rgba(34,197,94,0.08)";
                  badgeBorder = "rgba(34,197,94,0.25)";
                } else if (isActive) {
                  badgeLabel = "OPEN";
                  badgeColor = "#3B82F6";
                  badgeBg = "rgba(59,130,246,0.08)";
                  badgeBorder = "rgba(59,130,246,0.25)";
                } else if (isFailed) {
                  badgeLabel = "FAILED";
                  badgeColor = "#EF4444";
                  badgeBg = "rgba(239,68,68,0.08)";
                  badgeBorder = "rgba(239,68,68,0.25)";
                }

                return (
                  <div key={member.prId}>
                    <div style={{ display: "flex", alignItems: "stretch" }}>
                      {/* Connector column */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0 }}>
                        <div
                          style={{
                            width: 10,
                            height: 10,
                            background: dotColor,
                            flexShrink: 0,
                            marginTop: 6,
                            ...(isActive ? { boxShadow: `0 0 8px ${dotColor}80` } : {}),
                          }}
                        />
                        {!isLast && (
                          <div
                            style={{
                              width: 1,
                              flex: 1,
                              minHeight: 24,
                              background: isLanded ? "#22C55E" : "#1E1B26",
                              opacity: isLanded ? 0.5 : 1,
                            }}
                          />
                        )}
                      </div>

                      {/* Node content */}
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 12px",
                          marginBottom: isLast ? 0 : 2,
                          background: isActive
                            ? "rgba(59,130,246,0.05)"
                            : isLanded
                              ? "rgba(34,197,94,0.03)"
                              : "transparent",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            {/* Position number */}
                            <span
                              className="font-mono font-bold"
                              style={{ fontSize: 11, color: "#52525B", minWidth: 18, textAlign: "center" }}
                            >
                              {pad2(member.position + 1)}
                            </span>
                            {/* Lane name */}
                            <span
                              className="font-mono font-bold"
                              style={{
                                fontSize: 12,
                                color: "#FAFAFA",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {member.laneName}
                            </span>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                            {/* Checks badge */}
                            {member.pr && <ChecksBadge status={member.pr.checksStatus} />}
                            {/* Status badge */}
                            <span
                              className="font-mono font-bold uppercase tracking-[1px]"
                              style={{
                                fontSize: 10,
                                color: badgeColor,
                                background: badgeBg,
                                border: `1px solid ${badgeBorder}`,
                                padding: "2px 6px",
                              }}
                            >
                              {badgeLabel}
                            </span>
                            {/* Open in GitHub */}
                            {member.pr && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); void window.ade.prs.openInGitHub(member.prId); }}
                                style={{
                                  padding: 2,
                                  background: "transparent",
                                  border: "none",
                                  color: "#52525B",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#FAFAFA"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#52525B"; }}
                                title="Open in GitHub"
                              >
                                <GithubLogo size={13} />
                              </button>
                            )}
                            {/* Delete button (not on landed items) */}
                            {!isLanded && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(deleteTarget === member.prId ? null : member.prId); }}
                                style={{
                                  padding: 2,
                                  background: "transparent",
                                  border: "none",
                                  color: "#52525B",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#EF4444"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#52525B"; }}
                                title="Remove PR"
                              >
                                <Trash size={13} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* PR number + title */}
                        {member.pr && (
                          <div
                            className="font-mono"
                            style={{
                              marginTop: 4,
                              fontSize: 11,
                              color: "#71717A",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span style={{ color: "#52525B" }}>#{member.pr.githubPrNumber}</span>
                            {" "}
                            <span>{member.pr.title}</span>
                          </div>
                        )}

                        {/* Delete confirmation inline */}
                        {deleteTarget === member.prId && (
                          <div
                            style={{
                              marginTop: 8,
                              background: "rgba(239,68,68,0.05)",
                              border: "1px solid rgba(239,68,68,0.15)",
                              padding: 10,
                            }}
                          >
                            <div className="font-mono" style={{ fontSize: 11, color: "#EF4444", marginBottom: 8 }}>
                              REMOVE THIS PR FROM THE QUEUE?
                            </div>
                            <label
                              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#A1A1AA", cursor: "pointer", marginBottom: 8 }}
                              className="font-mono"
                            >
                              <input
                                type="checkbox"
                                checked={deleteCloseGh}
                                onChange={(e) => setDeleteCloseGh(e.target.checked)}
                                style={{ accentColor: "#A78BFA" }}
                              />
                              Also close on GitHub
                            </label>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <button
                                type="button"
                                disabled={deleteBusy}
                                onClick={() => void handleDeletePr(member.prId)}
                                className="font-mono font-bold uppercase tracking-[1px]"
                                style={{
                                  fontSize: 10,
                                  padding: "4px 10px",
                                  background: "transparent",
                                  border: "1px solid rgba(239,68,68,0.40)",
                                  color: "#EF4444",
                                  cursor: deleteBusy ? "not-allowed" : "pointer",
                                  opacity: deleteBusy ? 0.4 : 1,
                                }}
                              >
                                {deleteBusy ? "REMOVING..." : "CONFIRM"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(null)}
                                className="font-mono font-bold uppercase tracking-[1px]"
                                style={{
                                  fontSize: 10,
                                  padding: "4px 10px",
                                  background: "transparent",
                                  border: "1px solid #27272A",
                                  color: "#A1A1AA",
                                  cursor: "pointer",
                                }}
                              >
                                CANCEL
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ===== Errors / results banners ===== */}
          {landError && (
            <div
              className="font-mono"
              style={{
                background: "rgba(239,68,68,0.06)",
                border: "1px solid rgba(239,68,68,0.20)",
                padding: "10px 14px",
                fontSize: 11,
                color: "#EF4444",
              }}
            >
              {landError}
            </div>
          )}
          {landResult && (
            <div
              className="font-mono"
              style={{
                background: landResult.success ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)",
                border: `1px solid ${landResult.success ? "rgba(34,197,94,0.20)" : "rgba(239,68,68,0.20)"}`,
                padding: "10px 14px",
                fontSize: 11,
                color: landResult.success ? "#22C55E" : "#EF4444",
              }}
            >
              {landResult.success ? `Landed PR #${landResult.prNumber}` : `Failed: ${landResult.error ?? "unknown"}`}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No queue selected" description="Select a queue group to manage landing order." />
        </div>
      ),
    },
  }), [queueGroups, selectedGroup, selectedGroupId, landBusy, landError, landResult, archiveOnLand, mergeMethod, deleteTarget, deleteBusy, deleteCloseGh, rebaseNeeds, autoRebaseStatuses, setActiveTab, onSelectGroup, onRefresh]);

  return <PaneTilingLayout layoutId="prs:queue:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
