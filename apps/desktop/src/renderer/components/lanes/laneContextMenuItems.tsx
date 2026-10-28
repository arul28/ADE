import React from "react";
import {
  ChatCircle,
  Columns,
  Copy,
  FolderOpen,
  Gear,
  GitBranch,
  GitCommit,
  Globe,
  Link,
  Palette,
  Path,
  PushPin,
  PushPinSlash,
  Smiley,
  Stack,
  X,
  type Icon,
} from "@phosphor-icons/react";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import type { OpenInTarget } from "../../../shared/editorTargets";
import { buildDeeplink } from "../../../shared/deeplinks";
import { buildWebClientUrl } from "../../../shared/webClientUrl";
import { openExternalUrl } from "../../lib/openExternal";
import { revealLabel } from "../../lib/platform";
import { revealLaneWorktree } from "../../lib/revealLaneWorktree";
import { Z_LAYERS } from "../ui/zLayers";
import { COLORS, SANS_FONT, fgTint } from "./laneDesignTokens";
import { Banner } from "../ui/notice";
import { colorsInUse } from "./laneColorPalette";
import { LaneColorPicker } from "./LaneColorPicker";
import { showToast } from "../app/toast/toastStore";
import { laneEmojiForDisplay } from "../../../shared/laneEmoji";
import { LaneEmojiPicker } from "./LaneEmojiPicker";

export function LaneMenuGlyph({ icon: Icon }: { icon: Icon }) {
  return (
    <span
      aria-hidden
      data-menu-icon=""
      style={{ display: "inline-flex", flexShrink: 0, opacity: 0.45 }}
    >
      <Icon size={13} weight="duotone" />
    </span>
  );
}

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
  icon?: Icon;
};

/** A group entry that is not a row — today only the colour swatch grid. */
export type LaneMenuCustom = {
  kind: "custom";
  key: string;
  node: React.ReactNode;
};

export type LaneMenuOpenIn = {
  kind: "open-in";
  key: string;
} & OpenInTarget;

export type LaneMenuEntry = LaneMenuAction | LaneMenuCustom | LaneMenuOpenIn;

export type LaneMenuGroup = {
  key: string;
  /** Omitted for the top group, which needs no heading to be findable. */
  label?: string;
  entries: LaneMenuEntry[];
  /** Rendered as a hover submenu rather than inline rows. */
  submenu?: boolean;
  /** No divider above: continues the previous group's block (one-row groups). */
  joinPrevious?: boolean;
  icon?: Icon;
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
  /** History's commit graph on this lane. */
  onOpenHistory?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
  /** Work-sidebar pin key; foreign lanes use `machineId:laneId`. */
  workPinLaneId?: string;
  openIn?: OpenInTarget;
  /** Pin appearance/manage writes to a foreign runtime. */
  runtimePin?: OpenProjectBinding | null;
  /**
   * Split/tab actions navigate the local Lanes tab. A foreign lane is not in
   * that tab, so the session card's Lane submenu omits them.
   */
  omitTabActions?: boolean;
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
    onOpenHistory,
    workPinnedLaneIds,
    workPinLaneId,
    openIn,
    runtimePin = null,
    omitTabActions = false,
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
      icon: ChatCircle,
      dataTour: "lanes.startChatInLane",
      onSelect: () => { onClose(); onStartChatInLane(laneId); },
    });
  }
  const pinId = workPinLaneId ?? laneId;
  const isWorkPinned = Boolean(workPinnedLaneIds?.includes(pinId));
  if (lane && onToggleWorkPin) {
    top.push({
      kind: "action",
      key: "work-pin",
      label: isWorkPinned ? "Unpin" : "Pin",
      icon: isWorkPinned ? PushPinSlash : PushPin,
      onSelect: () => { onClose(); onToggleWorkPin(pinId); },
    });
  }
  if (top.length) groups.push({ key: "lane", entries: top });

  // ── Go to: surfaces outside this menu that show the same lane.
  const goTo: LaneMenuEntry[] = [];
  if (lane && onOpenHistory) {
    goTo.push({
      kind: "action",
      key: "commit-history",
      label: "Commit history",
      icon: GitCommit,
      onSelect: () => { onClose(); onOpenHistory(laneId); },
    });
  }
  if (lane?.worktreePath && !isRemoteProject) {
    goTo.push({
      kind: "action",
      key: "reveal",
      label: revealLabel,
      icon: FolderOpen,
      dataTour: "lanes.manageLane",
      onSelect: () => {
        onClose();
        void revealLaneWorktree(laneId);
      },
    });
  }
  if (lane) {
    goTo.push({
      kind: "action",
      key: "open-web",
      label: "Open in web",
      icon: Globe,
      onSelect: () => {
        onClose();
        openExternalUrl(buildWebClientUrl({ kind: "lane", laneId }));
      },
    });
  }
  if (goTo.length) groups.push({ key: "go-to", entries: goTo });

  // ── Copy: four near-identical "put a string on the clipboard" rows. They are
  //    the single biggest block in the flat menu and the one nobody reads, so
  //    they collapse behind one row.
  const copy: LaneMenuEntry[] = [];
  if (lane) {
    copy.push({
      kind: "action",
      key: "copy-lane-link",
      label: "Copy ADE lane link",
      icon: Link,
      onSelect: () => {
        onClose();
        void (async () => {
          const repo = await fetchRepoForCopy();
          const pr = await (runtimePin
            ? window.ade.prs.getForLane(lane.id, runtimePin)
            : window.ade.prs.getForLane(lane.id)).catch(() => null);
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
        label: "Copy branch link (any machine)",
        icon: GitBranch,
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
        label: "Copy Linear issue link",
        icon: Link,
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
      label: isRemoteProject ? "Copy remote path" : "Copy path",
      icon: Path,
      ...(isRemoteProject ? { dataTour: "lanes.manageLane" } : {}),
      onSelect: () => {
        onClose();
        window.ade.app.writeClipboardText(lane.worktreePath!).catch(() => {});
      },
    });
  }
  if (copy.length) groups.push({ key: "copy", label: "Copy", entries: copy, submenu: true, icon: Copy });

  if (lane && openIn) {
    groups.push({
      key: "open-in",
      joinPrevious: copy.length > 0,
      entries: [{ kind: "open-in", key: "open-in-editor", ...openIn }],
    });
  }

  if (lane) {
    groups.push({
      key: "color",
      label: "Color",
      icon: Palette,
      submenu: true,
      joinPrevious: groups.length > 0 && (groups[groups.length - 1]!.key === "copy" || groups[groups.length - 1]!.key === "open-in"),
      entries: [{
        kind: "custom",
        key: "swatches",
        node: (
          <ColorSwatchRow
            ctxLane={lane}
            lanesById={lanesById}
            onChanged={onAppearanceChanged}
            runtimePin={runtimePin}
          />
        ),
      }],
    });
    groups.push({
      key: "emoji",
      joinPrevious: true,
      entries: [{
        kind: "custom",
        key: "picker",
        node: (
          <LaneEmojiRow
            lane={lane}
            runtimePin={runtimePin}
            onChanged={onAppearanceChanged}
          />
        ),
      }],
    });
  }

  // ── Tabs: everything about which lanes are on screen.
  if (!omitTabActions) {
    const tabs: LaneMenuEntry[] = [];
    if (!isInSplit) {
      tabs.push({
        kind: "action",
        key: "open-split",
        label: "Open in split",
        icon: Columns,
        onSelect: () => { onClose(); selectLane(laneId); },
      });
    }
    if (isInSplit && splitCount > 1 && !isPrimary) {
      tabs.push({
        kind: "action",
        key: "remove-split",
        label: "Remove from split",
        icon: X,
        onSelect: () => { onClose(); onRemoveFromSplit(laneId); },
      });
    }
    if (isInSplit && splitCount > 1) {
      tabs.push({
        kind: "action",
        key: "close-other-tabs",
        label: "Close other tabs",
        icon: X,
        onSelect: () => { onClose(); onCloseOtherSplits(laneId); },
      });
    }
    tabs.push({
      kind: "action",
      key: "select-all",
      label: "Select all lanes",
      icon: Stack,
      onSelect: () => { onClose(); onSelectAll(); },
    });
    groups.push({
      key: "tabs",
      // Only worth a heading when it says something the rows do not.
      ...(splitCount > 1 ? { label: `${splitCount} tabs open` } : {}),
      entries: tabs,
    });
  }

  // ── Manage: last, because both entries open a surface that can delete.
  const manage: LaneMenuEntry[] = [];
  if (lane && !isPrimary) {
    manage.push({
      kind: "action",
      key: "manage",
      label: "Manage lane",
      icon: Gear,
      // Do not call selectLane here. On Work, that action navigates to the
      // Lanes tab (split-open). Manage must stay on the surface that opened it.
      onSelect: () => { onClose(); onManage(laneId); },
    });
  }
  if (deletableVisibleIds.length > 1) {
    manage.push({
      kind: "action",
      key: "batch-manage",
      label: `Manage ${deletableVisibleIds.length} open lanes…`,
      icon: Gear,
      onSelect: () => { onClose(); onBatchManage(deletableVisibleIds); },
    });
  }
  if (manage.length) {
    // Continues the tab actions' block: two one-row groups read as one.
    groups.push({ key: "manage", joinPrevious: groups[groups.length - 1]?.key === "tabs" && !groups[groups.length - 1]?.label, entries: manage });
  }

  return groups;
}

export const laneMenuHeaderStyle: React.CSSProperties = {
  padding: "5px 12px 3px",
  fontSize: 10.5,
  fontFamily: SANS_FONT,
  fontWeight: 500,
  color: COLORS.textDim,
  whiteSpace: "nowrap",
};

export function ColorSwatchRow({
  ctxLane,
  lanesById,
  onChanged,
  runtimePin = null,
}: {
  ctxLane: LaneSummary;
  lanesById: Map<string, LaneSummary>;
  onChanged?: () => void | Promise<void>;
  runtimePin?: OpenProjectBinding | null;
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
  const apply = async (next: string) => {
    setError(null);
    setBusy(true);
    try {
      await window.ade.lanes.updateAppearance({ laneId: ctxLane.id, color: next }, runtimePin);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set color");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "4px 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
      <LaneColorPicker
        value={ctxLane.color}
        onChange={(next) => { if (!busy) void apply(next); }}
        usedColors={used}
        usedColorOwners={owners}
        swatchSize={18}
        maxPerRow={7}
      />
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 4 }}
          model={{
            id: "lane-menu-color-error",
            tone: "error",
            title: error,
            report: { surface: "lane_context_menu_color" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
    </div>
  );
}


function LaneEmojiRow({
  lane,
  runtimePin,
  onChanged,
}: {
  lane: LaneSummary;
  runtimePin: OpenProjectBinding | null;
  onChanged?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);

  const apply = async (next: string | null) => {
    setBusy(true);
    try {
      await window.ade.lanes.updateAppearance({ laneId: lane.id, emoji: next }, runtimePin);
      await onChanged?.();
    } catch (err) {
      showToast({
        title: "Could not set the lane emoji",
        message: err instanceof Error ? err.message : "Failed to set emoji",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const laneEmoji = laneEmojiForDisplay(lane.emoji, lane.icon);
  // A normal menu row (icon, label, current value), so emoji reads like the
  // Color and Copy rows beside it rather than a boxed control.
  return (
    <LaneEmojiPicker
      value={laneEmoji}
      onChange={(next) => { void apply(next); }}
      disabled={busy}
      overlayLayer={Z_LAYERS.contextMenu}
      label="Lane emoji"
      trigger={(
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-fg/[0.06] disabled:opacity-50"
          style={{ fontFamily: SANS_FONT }}
        >
          <LaneMenuGlyph icon={Smiley} />
          <span className="flex-1">Emoji</span>
          <span className={laneEmoji ? "text-[13px] leading-none" : "text-[11px] text-muted-fg"}>{laneEmoji ?? "None"}</span>
        </button>
      )}
    />
  );
}
