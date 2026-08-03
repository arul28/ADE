import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import { buildWebClientUrl } from "../../../shared/webClientUrl";
import { openExternalUrl } from "../../lib/openExternal";
import { revealLabel } from "../../lib/platform";
import { COLORS, MONO_FONT } from "./laneDesignTokens";
import { LANE_CLASSIC_COLORS, LANE_RAINBOW_COLORS, colorsInUse, type LaneColor } from "./laneColorPalette";

/**
 * The lane menu's items, as data.
 *
 * There are two surfaces that must offer the *same* lane actions: the lane
 * divider's own right-click menu, and the "Lane ▸" submenu a singleton lane's
 * session menu carries (that row is its lane's only visible surface). They used
 * to stay in sync because the session menu simply re-opened the real lane menu
 * portal; now that it renders the items inline instead, this module is what
 * keeps the two from drifting — both render exactly these groups, so an action
 * added here shows up on both without anyone remembering to.
 */

export type LaneMenuAction = {
  kind: "action";
  key: string;
  label: string;
  onSelect: () => void;
  dataTour?: string;
};

/** A group entry that is not a row — today only the colour swatch grid. */
export type LaneMenuCustom = {
  kind: "custom";
  key: string;
  node: React.ReactNode;
};

export type LaneMenuEntry = LaneMenuAction | LaneMenuCustom;

export type LaneMenuGroup = {
  key: string;
  /** Omitted for the top group, which needs no heading to be findable. */
  label?: string;
  entries: LaneMenuEntry[];
  /** Rendered as a hover submenu rather than inline rows. */
  submenu?: boolean;
};

export type LaneMenuArgs = {
  laneId: string;
  lane: LaneSummary | null;
  lanesById: Map<string, LaneSummary>;
  visibleLaneIds: string[];
  isRemoteProject: boolean;
  onClose: () => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
  onRemoveFromSplit: (laneId: string) => void;
  onCloseOtherSplits: (keepLaneId: string) => void;
  onSelectAll: () => void;
  onBatchManage: (laneIds: string[]) => void;
  onAppearanceChanged?: () => void | Promise<void>;
  onStartChatInLane?: (laneId: string) => void;
  onToggleWorkPin?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
};

/**
 * Deliberately narrower than `prs/shared/laneBranchTargets`: the deep links
 * below only ever see a local `refs/heads/` ref, and stripping remote prefixes
 * too would silently turn `origin/x` into a branch link this lane does not own.
 */
function branchNameFromRef(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}

async function fetchRepoForCopy(): Promise<{ owner: string; name: string } | null> {
  try {
    const status = await window.ade.github.getRemoteStatus();
    return status.repo ?? null;
  } catch {
    return null;
  }
}

/**
 * Groups, in the order a first-time reader looks for them: what you do with the
 * lane, where you go, what you copy, how it is laid out, what it looks like,
 * and — last, because they open destructive surfaces — the manage entries.
 */
export function buildLaneMenuGroups(args: LaneMenuArgs): LaneMenuGroup[] {
  const {
    laneId,
    lane,
    lanesById,
    visibleLaneIds,
    isRemoteProject,
    onClose,
    onManage,
    selectLane,
    onRemoveFromSplit,
    onCloseOtherSplits,
    onSelectAll,
    onBatchManage,
    onAppearanceChanged,
    onStartChatInLane,
    onToggleWorkPin,
    workPinnedLaneIds,
  } = args;

  const isInSplit = visibleLaneIds.includes(laneId);
  const splitCount = visibleLaneIds.length;
  const isPrimary = lane?.laneType === "primary";
  const deletableVisibleIds = visibleLaneIds.filter((id) => {
    const candidate = lanesById.get(id);
    return candidate && candidate.laneType !== "primary";
  });
  const branch = branchNameFromRef(lane?.branchRef);

  const groups: LaneMenuGroup[] = [];

  // ── Top group: the two things you do TO the lane, unlabelled because they
  //    are the first rows under the cursor and need no signpost.
  const top: LaneMenuEntry[] = [];
  if (lane && onStartChatInLane) {
    top.push({
      kind: "action",
      key: "start-chat",
      label: "Start chat in lane",
      dataTour: "lanes.startChatInLane",
      onSelect: () => { onClose(); onStartChatInLane(laneId); },
    });
  }
  if (lane && onToggleWorkPin) {
    top.push({
      kind: "action",
      key: "work-pin",
      label: workPinnedLaneIds?.includes(laneId)
        ? "Unpin from Work sidebar"
        : "Pin to Work sidebar",
      onSelect: () => { onClose(); onToggleWorkPin(laneId); },
    });
  }
  if (top.length) groups.push({ key: "lane", entries: top });

  // ── Go to: surfaces outside this menu that show the same lane.
  const goTo: LaneMenuEntry[] = [];
  if (lane?.worktreePath && !isRemoteProject) {
    goTo.push({
      kind: "action",
      key: "reveal",
      label: revealLabel,
      dataTour: "lanes.manageLane",
      onSelect: () => {
        onClose();
        window.ade.app.revealPath(lane.worktreePath!).catch(() => {});
      },
    });
  }
  if (lane) {
    goTo.push({
      kind: "action",
      key: "open-web",
      label: "Open in web",
      onSelect: () => {
        onClose();
        openExternalUrl(buildWebClientUrl({ kind: "lane", laneId }));
      },
    });
  }
  if (goTo.length) groups.push({ key: "go-to", label: "Go to", entries: goTo });

  // ── Copy: four near-identical "put a string on the clipboard" rows. They are
  //    the single biggest block in the flat menu and the one nobody reads, so
  //    they collapse behind one row.
  const copy: LaneMenuEntry[] = [];
  if (lane) {
    copy.push({
      kind: "action",
      key: "copy-lane-link",
      label: "Copy ADE Lane Link",
      onSelect: () => {
        onClose();
        void (async () => {
          const repo = await fetchRepoForCopy();
          const pr = await window.ade.prs.getForLane(lane.id).catch(() => null);
          const url = buildDeeplink(
            {
              kind: "lane",
              laneId,
              ...(repo
                ? {
                    envelope: {
                      repoOwner: repo.owner,
                      repoName: repo.name,
                      ...(branch ? { branch } : {}),
                      ...(pr?.githubPrNumber ? { prNumber: pr.githubPrNumber } : {}),
                      ...(lane.linearIssue?.identifier
                        ? { linearIssue: lane.linearIssue.identifier }
                        : {}),
                    },
                  }
                : {}),
            },
            { form: "ade" },
          );
          await window.ade.app.writeClipboardText(url).catch(() => {});
        })();
      },
    });
    if (branch) {
      copy.push({
        kind: "action",
        key: "copy-branch-link",
        label: "Copy Branch Link (Cross-Machine)",
        onSelect: () => {
          onClose();
          void fetchRepoForCopy().then((repo) => {
            if (!repo) {
              // No GitHub origin — fall back to lane link as the best we can offer.
              const fallback = buildDeeplink({ kind: "lane", laneId }, { form: "ade" });
              return window.ade.app.writeClipboardText(fallback).catch(() => {});
            }
            const url = buildDeeplink({
              kind: "branch",
              repoOwner: repo.owner,
              repoName: repo.name,
              branch,
            });
            return window.ade.app.writeClipboardText(url).catch(() => {});
          });
        },
      });
    }
    if (lane.linearIssue?.url) {
      const linearUrl = lane.linearIssue.url;
      copy.push({
        kind: "action",
        key: "copy-linear-link",
        label: "Copy Linear Issue Link",
        onSelect: () => {
          onClose();
          window.ade.app.writeClipboardText(linearUrl).catch(() => {});
        },
      });
    }
  }
  if (lane?.worktreePath) {
    // A remote project has no local path to reveal, so the path is only ever
    // copyable there — same action, filed where copies live.
    copy.push({
      kind: "action",
      key: "copy-path",
      label: isRemoteProject ? "Copy Remote Path" : "Copy Path",
      ...(isRemoteProject ? { dataTour: "lanes.manageLane" } : {}),
      onSelect: () => {
        onClose();
        window.ade.app.writeClipboardText(lane.worktreePath!).catch(() => {});
      },
    });
  }
  if (copy.length) groups.push({ key: "copy", label: "Copy", entries: copy, submenu: true });

  // ── Tabs: everything about which lanes are on screen.
  const tabs: LaneMenuEntry[] = [];
  if (!isInSplit) {
    tabs.push({
      kind: "action",
      key: "open-split",
      label: "Open in Split",
      onSelect: () => { onClose(); selectLane(laneId); },
    });
  }
  if (isInSplit && splitCount > 1 && !isPrimary) {
    tabs.push({
      kind: "action",
      key: "remove-split",
      label: "Remove from Split",
      onSelect: () => { onClose(); onRemoveFromSplit(laneId); },
    });
  }
  if (isInSplit && splitCount > 1) {
    tabs.push({
      kind: "action",
      key: "close-other-tabs",
      label: "Close Other Tabs",
      onSelect: () => { onClose(); onCloseOtherSplits(laneId); },
    });
  }
  tabs.push({
    kind: "action",
    key: "select-all",
    label: "Select All Lanes",
    onSelect: () => { onClose(); onSelectAll(); },
  });
  groups.push({
    key: "tabs",
    label: splitCount > 1 ? `${splitCount} tabs open` : "Tabs",
    entries: tabs,
  });

  if (lane) {
    groups.push({
      key: "color",
      label: "Color",
      entries: [{
        kind: "custom",
        key: "swatches",
        node: (
          <ColorSwatchRow
            ctxLane={lane}
            lanesById={lanesById}
            onChanged={onAppearanceChanged}
          />
        ),
      }],
    });
  }

  // ── Manage: last, because both entries open a surface that can delete.
  const manage: LaneMenuEntry[] = [];
  if (lane && !isPrimary) {
    manage.push({
      kind: "action",
      key: "manage",
      label: "Manage Lane",
      onSelect: () => { onClose(); selectLane(laneId); onManage(laneId); },
    });
  }
  if (deletableVisibleIds.length > 1) {
    manage.push({
      kind: "action",
      key: "batch-manage",
      label: `Manage ${deletableVisibleIds.length} Open Lanes...`,
      onSelect: () => { onClose(); onBatchManage(deletableVisibleIds); },
    });
  }
  if (manage.length) groups.push({ key: "manage", label: "Manage", entries: manage });

  return groups;
}

export const laneMenuHeaderStyle: React.CSSProperties = {
  padding: "5px 14px 3px",
  fontSize: 9,
  fontFamily: MONO_FONT,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: COLORS.textDim,
};

export function ColorSwatchRow({
  ctxLane,
  lanesById,
  onChanged,
}: {
  ctxLane: LaneSummary;
  lanesById: Map<string, LaneSummary>;
  onChanged?: () => void | Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const lanesArray = React.useMemo(() => Array.from(lanesById.values()), [lanesById]);
  const used = React.useMemo(() => colorsInUse(lanesArray, ctxLane.id), [lanesArray, ctxLane.id]);
  const owners = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanesArray) {
      if (lane.archivedAt || lane.id === ctxLane.id || !lane.color) continue;
      map.set(lane.color.toLowerCase(), lane.name);
    }
    return map;
  }, [lanesArray, ctxLane.id]);
  const currentLower = ctxLane.color?.toLowerCase() ?? null;

  const apply = async (next: string | null) => {
    setError(null);
    setBusy(true);
    try {
      await window.ade.lanes.updateAppearance({ laneId: ctxLane.id, color: next });
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set color");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "4px 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
      <SwatchGroup
        label="Rainbow"
        colors={LANE_RAINBOW_COLORS}
        selectedLower={currentLower}
        used={used}
        owners={owners}
        busy={busy}
        onPick={apply}
      />
      <SwatchGroup
        label="Classic"
        colors={LANE_CLASSIC_COLORS}
        selectedLower={currentLower}
        used={used}
        owners={owners}
        busy={busy}
        onPick={apply}
        trailing={currentLower ? (
          <button
            type="button"
            title="Clear color"
            aria-label="Clear color"
            disabled={busy}
            onClick={() => apply(null)}
            style={{
              width: 18,
              height: 18,
              borderRadius: 9999,
              backgroundColor: "transparent",
              cursor: busy ? "not-allowed" : "pointer",
              border: "1px dashed rgba(255,255,255,0.35)",
              padding: 0,
              color: "rgba(255,255,255,0.55)",
              fontSize: 10,
              lineHeight: "16px",
            }}
          >
            ✕
          </button>
        ) : null}
      />
      {error ? (
        <div style={{ marginTop: 2, fontSize: 10, color: "#f87171", fontFamily: MONO_FONT }}>{error}</div>
      ) : null}
    </div>
  );
}

function SwatchGroup({
  label,
  colors,
  selectedLower,
  used,
  owners,
  busy,
  onPick,
  trailing,
}: {
  label: string;
  colors: readonly LaneColor[];
  selectedLower: string | null;
  used: Set<string>;
  owners: Map<string, string>;
  busy: boolean;
  onPick: (hex: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: COLORS.textDim,
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {colors.map((entry) => {
          const lower = entry.hex.toLowerCase();
          const isSelected = selectedLower === lower;
          const isTaken = !isSelected && used.has(lower);
          const owner = isTaken ? owners.get(lower) ?? null : null;
          const title = isTaken
            ? owner
              ? `${entry.name} — used by ${owner}`
              : `${entry.name} — in use`
            : entry.name;
          return (
            <button
              key={entry.hex}
              type="button"
              title={title}
              disabled={isTaken || busy}
              aria-label={title}
              aria-pressed={isSelected}
              onClick={() => onPick(entry.hex)}
              style={{
                position: "relative",
                width: 18,
                height: 18,
                borderRadius: 9999,
                backgroundColor: entry.hex,
                opacity: isTaken ? 0.65 : 1,
                cursor: isTaken ? "not-allowed" : "pointer",
                outline: isSelected ? `2px solid ${COLORS.textPrimary}` : "none",
                outlineOffset: 1,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
                border: "none",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isTaken ? (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ color: "rgba(255,255,255,0.95)", filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.45))" }}
                >
                  <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </button>
          );
        })}
        {trailing}
      </div>
    </div>
  );
}
