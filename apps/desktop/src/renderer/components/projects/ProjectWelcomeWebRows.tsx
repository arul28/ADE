import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  Folder,
  GitMerge,
  PushPin,
  X,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import {
  welcomeProjectMachineName,
  type RecentProjectLocation,
} from "../app/projectTabGrouping";
import {
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
          width: 28,
          height: 28,
          borderRadius: 5,
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

export type WebRowChrome = {
  status: WebMachineStatus;
  connectStage: string | null;
  /** The catalog behind this row is cached, waiting on live data. */
  stale: boolean;
};

export function WebRowTrailing({
  web,
  lastActiveAt,
}: {
  web: WebRowChrome;
  lastActiveAt: string | null;
}) {
  return (
    <>
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
      ) : (
        <ProjectActivity lastActiveAt={lastActiveAt} />
      )}
    </>
  );
}

function ProjectActivity({ lastActiveAt }: { lastActiveAt: string | null }) {
  if (!lastActiveAt) return null;
  const activity = toRelativeTime(lastActiveAt);
  const activityLabel = activity.startsWith("active ")
    ? activity.slice("active ".length)
    : activity;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        fontSize: 9,
        color: COLORS.textDim,
        textAlign: "right",
        whiteSpace: "nowrap",
      }}
    >
      {activityLabel}
    </span>
  );
}

function machineLocationKey(location: RecentProjectLocation): string {
  return `${location.machineId}:${location.recentKey ?? location.summary.rootPath}`;
}

/** A compact, explicit roster for every machine that has this project. */
function ProjectMachineList({
  locations,
  primary,
  busy,
  isOpen,
  onSelectMachine,
}: {
  locations: readonly RecentProjectLocation[];
  primary: RecentProjectLocation;
  busy: boolean;
  isOpen: boolean;
  onSelectMachine?: (location: RecentProjectLocation) => void;
}) {
  if (locations.length === 0) return null;
  const orderedLocations = [
    ...locations.filter((location) => location.summary.kind !== "remote"),
    ...locations.filter((location) => location.summary.kind === "remote"),
  ];
  return (
    <div
      data-ade-project-machines="true"
      aria-label="Project machines"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        justifyContent: "flex-start",
        padding: "2px 16px 8px",
        color: COLORS.textMuted,
      }}
    >
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: COLORS.textDim,
          flexShrink: 0,
        }}
      >
        On
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          minWidth: 0,
          flex: "1 1 auto",
        }}
      >
        {orderedLocations.map((location) => {
          const locationIndex = orderedLocations.indexOf(location);
          const isPrimary = location === primary;
          const canSelect = !isPrimary && Boolean(onSelectMachine) && !busy;
          const machineName = welcomeProjectMachineName(location);
          const content = (
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {machineName}
            </span>
          );
          const sharedStyle = {
            display: "inline-flex",
            alignItems: "center",
            maxWidth: 190,
            padding: 0,
            border: 0,
            background: "transparent",
            color: isPrimary ? COLORS.textSecondary : COLORS.textMuted,
            fontFamily: MONO_FONT,
            fontSize: 9,
            cursor: canSelect ? "pointer" : "default",
          } as const;
          return (
            <span key={machineLocationKey(location)} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {locationIndex > 0 ? (
                <span aria-hidden style={{ color: COLORS.textDim }}>
                  ·
                </span>
              ) : null}
              {canSelect ? (
                <button
                  type="button"
                  title={`Open on ${machineName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectMachine?.(location);
                  }}
                  style={{
                    ...sharedStyle,
                    appearance: "none",
                  }}
                >
                  {content}
                </button>
              ) : (
                <span
                  title={isPrimary ? "Current project machine" : machineName}
                  style={sharedStyle}
                >
                  {content}
                </span>
              )}
            </span>
          );
        })}
      </div>
      {isOpen ? (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            marginLeft: "auto",
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: COLORS.accent,
          }}
        >
          Open
        </span>
      ) : null}
    </div>
  );
}

// A single recents row. The project is the visual anchor; machine locations
// are listed below it, so a computer icon never competes with a real project
// logo. Offline remote rows are dimmed with a Reconnect affordance.
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
  primary,
  locations,
  onSelectMachine,
  lastActiveAt,
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
  primary: RecentProjectLocation;
  locations: readonly RecentProjectLocation[];
  onSelectMachine?: (location: RecentProjectLocation) => void;
  lastActiveAt: string | null;
  /** Present only on the hosted client, where every row is a machine's repo. */
  web?: WebRowChrome | null;
}) {
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const isRemote = rp.kind === "remote" && Boolean(rp.remote);
  const connecting = connectionState === "connecting";
  const parked = connectionState === "parked";
  // Remote rows are "offline" until their target reports a live connection. On
  // web, a machine that is merely dialable is not dimmed — it opens on click.
  const offline = web ? web.status === "offline" : isRemote && connectionState !== "connected";
  const projectIconDataUrl = locations
    .map((location) => location.summary.remote?.iconDataUrl ?? null)
    .find((dataUrl): dataUrl is string => Boolean(dataUrl)) ?? null;
  const localIconRootPath = locations.find(
    (location) => location.summary.kind !== "remote",
  )?.summary.rootPath ?? null;
  const hasProjectArtwork = Boolean(projectIconDataUrl || localIconRootPath);
  const tileAccent = accentColor;
  const tileBg = tileAccent
    ? `color-mix(in srgb, ${tileAccent} 18%, transparent)`
    : "color-mix(in srgb, var(--color-accent) 15%, transparent)";
  const tileColor = tileAccent ?? COLORS.accent;
  const edgeColor = tileAccent ?? COLORS.accent;
  // Pin / forget / merge are desktop-recents operations; the hosted client's
  // list is the machines' own catalogs, which it does not own.
  const showRowActions = !connecting && !web;
  const showMergeAction = Boolean(onMerge && rp.worktreeOf && showRowActions);

  return (
    <div
      className="group"
      style={{ position: "relative" }}
      data-ade-stale={web?.stale ? "true" : undefined}
    >
      <div
        style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid color-mix(in srgb, ${edgeColor} 60%, transparent)`,
          borderRadius: 12,
          overflow: "hidden",
          backdropFilter: "blur(10px)",
          opacity: busy ? 0.45 : offline ? 0.6 : 1,
        }}
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
            padding: "10px 16px 2px",
            paddingRight: showMergeAction ? 94 : 16,
            width: "100%",
            background: "transparent",
            border: 0,
            color: COLORS.textPrimary,
            fontFamily: MONO_FONT,
            fontSize: 12,
            cursor: busy ? "default" : "pointer",
            textAlign: "left",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: hasProjectArtwork ? 0 : 8,
              background: hasProjectArtwork ? "transparent" : tileBg,
              color: tileColor,
              flexShrink: 0,
              position: "relative",
            }}
          >
            {projectIconDataUrl ? (
              <ProjectIconArtwork
                dataUrl={projectIconDataUrl}
                fallback={<Folder size={16} weight="regular" />}
                onAccentColor={setAccentColor}
              />
            ) : localIconRootPath ? (
              <RecentProjectIcon
                rootPath={localIconRootPath}
                onAccentColor={setAccentColor}
              />
            ) : (
              <Folder size={16} weight="regular" />
            )}
          </div>
          <div style={{ overflow: "hidden", flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 2,
                minWidth: 0,
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
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignSelf: "stretch",
              alignItems: "flex-end",
              justifyContent: "flex-start",
              paddingTop: 1,
              gap: 6,
              flexShrink: 0,
              minWidth: web?.connectStage ? 108 : connecting ? 96 : 68,
              maxWidth: web?.connectStage ? 132 : connecting ? 116 : 96,
            }}
          >
            {web ? (
              <WebRowTrailing
                web={web}
                lastActiveAt={lastActiveAt}
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
            ) : !connecting ? <ProjectActivity lastActiveAt={lastActiveAt} /> : null}
          </div>
        </button>
        <ProjectMachineList
          locations={locations}
          primary={primary}
          busy={busy}
          isOpen={isOpen}
          onSelectMachine={onSelectMachine}
        />
      </div>
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
    </div>
  );
}
