import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  DesktopTower,
  Folder,
  GitMerge,
  PushPin,
  X,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import type { RecentProjectLocation } from "../app/projectTabGrouping";
import {
  WEB_MACHINE_DOT_COLOR,
  type WebMachineStatus,
} from "../../webclient/workspace/webWorkspaceModel";
import { WorktreeBadge } from "./WorktreeBadge";
import { deriveIconAccentColor } from "../../lib/iconAccent";
import { abbreviateHome } from "../../lib/pathUtils";
import { toRelativeTime } from "../graph/graphHelpers";
import type {
  ProjectIcon,
  RecentProjectSummary,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// The recents-row chrome, and the hosted client's empty/notice states.
//
// Split out of ProjectWelcomePage because none of it reads that page's state:
// every export here is driven entirely by its props, which is what makes the
// welcome page's own body readable as page logic rather than row markup.
// ---------------------------------------------------------------------------

export function ProjectIconArtwork({
  dataUrl,
  fallback,
  onAccentColor,
}: {
  dataUrl: string | null | undefined;
  fallback: ReactNode;
  // Reports the icon's sampled accent color (or null) so the row can tint its
  // tile to match the logo. Fires null until an icon resolves.
  onAccentColor?: (color: string | null) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [dataUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!dataUrl || failed) {
      onAccentColor?.(null);
      return () => {
        cancelled = true;
      };
    }
    deriveIconAccentColor(dataUrl)
      .then((color) => {
        if (!cancelled) onAccentColor?.(color);
      })
      .catch(() => {
        if (!cancelled) onAccentColor?.(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataUrl, failed, onAccentColor]);

  if (dataUrl && !failed) {
    return (
      <img
        src={dataUrl}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          objectFit: "contain",
        }}
      />
    );
  }

  return <>{fallback}</>;
}

function RecentProjectIcon({
  rootPath,
  onAccentColor,
}: {
  rootPath: string;
  onAccentColor?: (color: string | null) => void;
}) {
  const [icon, setIcon] = useState<ProjectIcon | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIcon(null);
    window.ade.project
      .resolveIcon(rootPath)
      .then((nextIcon) => {
        if (!cancelled) setIcon(nextIcon);
      })
      .catch(() => {
        if (!cancelled) setIcon(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  return (
    <ProjectIconArtwork
      dataUrl={icon?.dataUrl}
      fallback={<Folder size={16} weight="regular" />}
      onAccentColor={onAccentColor}
    />
  );
}

export const REMOTE_ACCENT = "#F59E0B";

export type WebRowChrome = {
  machineName: string;
  status: WebMachineStatus;
  reachability: string;
  connectStage: string | null;
  /** The catalog behind this row is cached, waiting on live data. */
  stale: boolean;
  alsoOn: { key: string; machineName: string; onSelect: () => void }[];
};

export function WebMachineBadge({ web }: { web: WebRowChrome }) {
  return (
    <span
      title={web.reachability}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.05)",
        color: COLORS.textSecondary,
        border: `1px solid ${COLORS.border}`,
        flexShrink: 0,
        maxWidth: 150,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flexShrink: 0,
          background: WEB_MACHINE_DOT_COLOR[web.status],
          animation:
            web.status === "connecting"
              ? "ade-recent-dot-pulse 1.1s ease-in-out infinite"
              : undefined,
        }}
      />
      {web.machineName}
    </span>
  );
}

export function WebRowTrailing({
  web,
  laneCount,
  lastOpenedAt,
}: {
  web: WebRowChrome;
  laneCount: number | undefined;
  lastOpenedAt: string | null;
}) {
  const connectsOnOpen = web.status !== "live" && !web.connectStage;
  return (
    <>
      {laneCount !== undefined ? (
        <span
          style={{
            fontSize: 10,
            background: "color-mix(in srgb, var(--color-accent) 20%, transparent)",
            color: COLORS.accent,
            padding: "2px 6px",
            borderRadius: 10,
            fontWeight: 600,
          }}
        >
          {laneCount} lane{laneCount !== 1 ? "s" : ""}
        </span>
      ) : null}
      {web.connectStage ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.03em",
            color: "#FBBF24",
            textAlign: "right",
          }}
        >
          <ArrowsClockwise
            size={11}
            weight="bold"
            style={{ animation: "ade-recent-spin 0.9s linear infinite" }}
          />
          {web.connectStage}
        </span>
      ) : lastOpenedAt ? (
        <span style={{ fontSize: 9, color: COLORS.textDim }}>
          {toRelativeTime(lastOpenedAt)}
        </span>
      ) : null}
      {connectsOnOpen ? (
        <span style={{ fontSize: 9, color: COLORS.textMuted }}>(connects on open)</span>
      ) : null}
    </>
  );
}

export function WebAlsoOnSwitcher({ web }: { web: WebRowChrome }) {
  const [open, setOpen] = useState(false);

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Open on another machine: ${web.alsoOn.map((entry) => entry.machineName).join(", ")}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.stopPropagation();
          event.preventDefault();
          setOpen((value) => !value);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          minHeight: 22,
          padding: "2px 4px",
          borderRadius: 6,
          color: COLORS.textMuted,
          cursor: "pointer",
        }}
      >
        Also on {web.alsoOn.map((entry) => entry.machineName).join(", ")}
        <CaretDown size={9} weight="bold" />
      </span>
      {open ? (
        <span
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            minWidth: 160,
            padding: 4,
            borderRadius: 10,
            background: "rgba(20,18,28,0.98)",
            border: `1px solid ${COLORS.border}`,
            boxShadow: "0 10px 32px rgba(0,0,0,0.45)",
          }}
        >
          {web.alsoOn.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                entry.onSelect();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 32,
                padding: "0 8px",
                borderRadius: 7,
                border: 0,
                background: "transparent",
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 11,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <DesktopTower size={12} weight="duotone" />
              {entry.machineName}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// A single recents row. Local rows resolve a project icon (and tint their tile
// with the sampled accent); remote rows use a host-resolved icon when present,
// plus the amber machine badge and connection dot. Offline remote rows are
// dimmed with a Reconnect affordance.
export function RecentProjectRow({
  rp,
  connectionState,
  isOpen,
  isForgetting,
  busy = false,
  onOpen,
  onTogglePin,
  onForget,
  onMerge,
  alsoOn = [],
  web = null,
}: {
  rp: RecentProjectSummary;
  connectionState: RemoteRuntimeConnectionState | null;
  isOpen: boolean;
  isForgetting: boolean;
  /** Another row is being opened — this one waits its turn, silently. */
  busy?: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onForget: () => void;
  onMerge?: () => void;
  alsoOn?: RecentProjectLocation[];
  /** Present only on the hosted client, where every row is a machine's repo. */
  web?: WebRowChrome | null;
}) {
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const isRemote = rp.kind === "remote" && Boolean(rp.remote);
  const connected = connectionState === "connected";
  const connecting = connectionState === "connecting";
  const parked = connectionState === "parked";
  // Remote rows are "offline" until their target reports a live connection. On
  // web, a machine that is merely dialable is not dimmed — it opens on click.
  const offline = web ? web.status === "offline" : isRemote && !connected;
  const remoteIconDataUrl = isRemote ? rp.remote?.iconDataUrl : null;
  const hasRemoteIcon = Boolean(remoteIconDataUrl);
  let tileAccent = accentColor;
  if (isRemote) {
    tileAccent = hasRemoteIcon ? (accentColor ?? REMOTE_ACCENT) : REMOTE_ACCENT;
  }
  const tileBg = tileAccent
    ? `color-mix(in srgb, ${tileAccent} 18%, transparent)`
    : "color-mix(in srgb, var(--color-accent) 15%, transparent)";
  const tileColor = tileAccent ?? COLORS.accent;
  const edgeColor = isRemote ? REMOTE_ACCENT : (tileAccent ?? COLORS.accent);
  // Pin / forget / merge are desktop-recents operations; the hosted client's
  // list is the machines' own catalogs, which it does not own.
  const showRowActions = !connecting && !web;
  const showMergeAction = Boolean(onMerge && rp.worktreeOf && showRowActions);

  const dotColor = connected
    ? "#34D399"
    : connecting
      ? REMOTE_ACCENT
      : "rgba(148,163,184,0.7)";

  return (
    <div
      className="group"
      style={{ position: "relative" }}
      data-ade-stale={web?.stale ? "true" : undefined}
    >
      <button
        type="button"
        data-tour="project.recentProject"
        onClick={onOpen}
        disabled={busy}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          paddingRight: showMergeAction ? 90 : showRowActions ? 64 : 16,
          width: "100%",
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid color-mix(in srgb, ${edgeColor} 60%, transparent)`,
          borderRadius: 12,
          color: COLORS.textPrimary,
          fontFamily: MONO_FONT,
          fontSize: 12,
          cursor: busy ? "default" : "pointer",
          textAlign: "left",
          transition: "all 0.2s ease",
          backdropFilter: "blur(10px)",
          opacity: busy ? 0.45 : offline ? 0.6 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 8,
            background: tileBg,
            color: tileColor,
            flexShrink: 0,
            position: "relative",
          }}
        >
          {isRemote ? (
            <>
              <ProjectIconArtwork
                dataUrl={remoteIconDataUrl}
                fallback={<DesktopTower size={18} weight="duotone" />}
                onAccentColor={setAccentColor}
              />
              {hasRemoteIcon ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    right: -3,
                    bottom: -3,
                    width: 14,
                    height: 14,
                    borderRadius: 5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(18,13,6,0.94)",
                    border: "1px solid color-mix(in srgb, #F59E0B 62%, transparent)",
                    color: "#FBBF24",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                  }}
                >
                  <DesktopTower size={9} weight="duotone" />
                </span>
              ) : null}
            </>
          ) : (
            <RecentProjectIcon
              rootPath={rp.rootPath}
              onAccentColor={setAccentColor}
            />
          )}
        </div>
        <div style={{ overflow: "hidden", flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 2,
            }}
          >
            <span
              style={{
                fontWeight: 600,
                fontSize: 13,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {rp.displayName}
            </span>
            {web ? <WebMachineBadge web={web} /> : isRemote && rp.remote ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  padding: "2px 7px",
                  borderRadius: 8,
                  background: "color-mix(in srgb, #F59E0B 16%, transparent)",
                  color: "#FBBF24",
                  border: "1px solid color-mix(in srgb, #F59E0B 30%, transparent)",
                  flexShrink: 0,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotColor,
                    animation: connecting
                      ? "ade-recent-dot-pulse 1.1s ease-in-out infinite"
                      : undefined,
                  }}
                />
                {rp.remote.runtimeName}
              </span>
            ) : null}
            {!isRemote && rp.worktreeOf ? (
              <WorktreeBadge worktreeOf={rp.worktreeOf} />
            ) : null}
          </div>
          <div
            style={{
              fontSize: 10,
              color: COLORS.textDim,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isRemote ? rp.rootPath : abbreviateHome(rp.rootPath)}
          </div>
          {web && web.alsoOn.length > 0 ? (
            <div
              style={{
                marginTop: 3,
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 9,
                color: COLORS.textMuted,
              }}
            >
              <DesktopTower size={10} weight="duotone" color={REMOTE_ACCENT} />
              <WebAlsoOnSwitcher web={web} />
            </div>
          ) : !web && alsoOn.length > 0 ? (
            <div
              style={{
                marginTop: 3,
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 9,
                color: COLORS.textMuted,
              }}
            >
              <DesktopTower size={10} weight="duotone" color={REMOTE_ACCENT} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Also on {alsoOn.map((location) => location.machineName).join(", ")}
              </span>
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
            flexShrink: 0,
            minWidth: web?.connectStage ? 108 : connecting ? 96 : 68,
            maxWidth: web?.connectStage ? 132 : connecting ? 116 : 96,
          }}
        >
          {web ? (
            <WebRowTrailing
              web={web}
              laneCount={rp.laneCount}
              lastOpenedAt={rp.lastOpenedAt || null}
            />
          ) : offline ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: connecting ? "#FBBF24" : COLORS.textMuted,
              }}
            >
              <ArrowsClockwise
                size={11}
                weight="bold"
                style={
                  connecting
                    ? { animation: "ade-recent-spin 0.9s linear infinite" }
                    : undefined
                }
              />
              {connecting ? "Reconnecting" : parked ? "Resume" : "Reconnect"}
            </span>
          ) : rp.laneCount !== undefined ? (
            <span
              style={{
                fontSize: 10,
                background:
                  "color-mix(in srgb, var(--color-accent) 20%, transparent)",
                color: COLORS.accent,
                padding: "2px 6px",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              {rp.laneCount} lane{rp.laneCount !== 1 ? "s" : ""}
            </span>
          ) : null}
          {rp.lastOpenedAt && !connecting ? (
            <span style={{ fontSize: 9, color: COLORS.textDim }}>
              {toRelativeTime(rp.lastOpenedAt)}
            </span>
          ) : null}
        </div>
      </button>
      {showRowActions ? (
        <div
          className={
            rp.pinned ? undefined : "opacity-0 group-hover:opacity-100"
          }
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            display: "flex",
            gap: 4,
            transition: "opacity 0.15s ease",
            zIndex: 2,
          }}
        >
          {onMerge && rp.worktreeOf ? (
            <button
              type="button"
              aria-label={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
              title={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
              onClick={(e) => {
                e.stopPropagation();
                onMerge();
              }}
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: COLORS.textDim,
                cursor: "pointer",
                transition: "background 0.15s ease, color 0.15s ease",
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  "color-mix(in srgb, var(--color-accent) 22%, transparent)";
                e.currentTarget.style.color = COLORS.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                e.currentTarget.style.color = COLORS.textDim;
              }}
            >
              <GitMerge size={12} weight="bold" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={
              rp.pinned
                ? `Unpin ${rp.displayName}`
                : `Pin ${rp.displayName} to top`
            }
            aria-pressed={rp.pinned ? true : false}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: rp.pinned
                ? "color-mix(in srgb, var(--color-accent) 26%, transparent)"
                : "rgba(255,255,255,0.06)",
              border: rp.pinned
                ? "1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)"
                : "1px solid rgba(255,255,255,0.08)",
              color: rp.pinned ? COLORS.accent : COLORS.textDim,
              cursor: "pointer",
              transition: "background 0.15s ease, color 0.15s ease",
              padding: 0,
            }}
            title={rp.pinned ? "Unpin" : "Pin to top"}
          >
            <PushPin size={12} weight={rp.pinned ? "fill" : "regular"} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${rp.displayName} from recents`}
            onClick={(e) => {
              e.stopPropagation();
              onForget();
            }}
            disabled={isForgetting}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: COLORS.textDim,
              cursor: "pointer",
              transition: "background 0.15s ease, color 0.15s ease",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.18)";
              e.currentTarget.style.color = "#EF4444";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = COLORS.textDim;
            }}
            title="Remove from recents"
          >
            <X size={12} weight="bold" />
          </button>
        </div>
      ) : null}
      {isOpen ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 6,
            left: 10,
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: COLORS.accent,
            pointerEvents: "none",
          }}
        >
          Open
        </span>
      ) : null}
    </div>
  );
}
