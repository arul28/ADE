import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowsClockwise,
  Folder,
  GitMerge,
  PushPin,
  X,
} from "@phosphor-icons/react";
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
import type {
  ProjectIcon,
  RecentProjectSummary,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// The recents-row chrome for the welcome page.
//
// Split out of ProjectWelcomePage because none of it reads that page's state:
// every export here is driven entirely by its props, which is what makes the
// welcome page's own body readable as page logic rather than row markup.
// Styling lives in `ProjectWelcomePage.css` (theme tokens only).
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
  onResolved,
}: {
  rootPath: string;
  onAccentColor?: (color: string | null) => void;
  onResolved?: (hasArtwork: boolean) => void;
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

  useEffect(() => {
    onResolved?.(Boolean(icon?.dataUrl));
  }, [icon?.dataUrl, onResolved]);

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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A path as a person reads it: home folders become `~`, on this machine and on
 * others. `abbreviateHome` only knows this process's HOME (and the renderer
 * often has none), and a remote machine's home is never ours, so a user-home
 * prefix is recognised by shape as a fallback. Display only — the full path
 * stays in the tooltip.
 */
function welcomeDisplayPath(rootPath: string): string {
  const abbreviated = abbreviateHome(rootPath);
  if (abbreviated !== rootPath) return abbreviated;
  const normalized = rootPath.replace(/\\/g, "/");
  const home = normalized.match(/^(?:\/Users|\/home)\/[^/]+(\/.*)?$/)
    ?? normalized.match(/^[A-Za-z]:\/Users\/[^/]+(\/.*)?$/);
  if (home) return `~${home[1] ?? ""}`;
  return rootPath;
}

/** Middle truncation: the folder name survives, the parent path gives way. */
function MiddleTruncatedPath({ path, title }: { path: string; title: string }) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  // The separator leads the tail, so a clipped head reads "~/Projects/…/ADE".
  const head = cut > 0 ? trimmed.slice(0, cut) : "";
  const tail = cut > 0 ? trimmed.slice(cut) : trimmed;
  return (
    <span className="ade-welcome-path" title={title}>
      <span>{head}</span>
      <span>{tail}</span>
    </span>
  );
}

/** "just now", "12m ago", "3h ago", "5d ago", then a calendar date. */
export function welcomeRelativeTime(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const delta = Math.max(0, nowMs - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Machine chips
// ---------------------------------------------------------------------------

type DotState = "online" | "busy" | "available" | "offline";

function locationDotState(
  location: RecentProjectLocation,
  isPrimary: boolean,
  web: WebRowChrome | null,
): DotState {
  if (location.summary.kind !== "remote") {
    return location.summary.exists === false ? "offline" : "online";
  }
  if (web && isPrimary) {
    if (web.status === "live") return "online";
    if (web.status === "connecting") return "busy";
    if (web.status === "available") return "available";
    return "offline";
  }
  if (location.connectionState === "connected") return "online";
  if (location.connectionState === "connecting") return "busy";
  return "offline";
}

const DOT_LABEL: Record<DotState, string> = {
  online: "online",
  busy: "connecting",
  available: "available",
  offline: "offline",
};

function machineLocationKey(location: RecentProjectLocation): string {
  return `${location.machineId}:${location.recentKey ?? location.summary.rootPath}`;
}

/** One chip per machine that has this project; the others open it there. */
function ProjectMachineChips({
  locations,
  primary,
  busy,
  web,
  onSelectMachine,
}: {
  locations: readonly RecentProjectLocation[];
  primary: RecentProjectLocation;
  busy: boolean;
  web: WebRowChrome | null;
  onSelectMachine?: (location: RecentProjectLocation) => void;
}) {
  if (locations.length === 0) return null;
  const orderedLocations = [
    ...locations.filter((location) => location.summary.kind !== "remote"),
    ...locations.filter((location) => location.summary.kind === "remote"),
  ];
  return (
    <div
      className="ade-welcome-chips"
      data-ade-project-machines="true"
      aria-label="Project machines"
    >
      {orderedLocations.map((location) => {
        const isPrimary = location === primary;
        const canSelect = !isPrimary && Boolean(onSelectMachine) && !busy;
        const machineName = welcomeProjectMachineName(location);
        const dot = locationDotState(location, isPrimary, web);
        const content = (
          <>
            <span aria-hidden className="ade-welcome-dot" data-state={dot} />
            <span>{machineName}</span>
          </>
        );
        return canSelect ? (
          <button
            key={machineLocationKey(location)}
            type="button"
            className="ade-welcome-chip"
            title={`Open on ${machineName} (${DOT_LABEL[dot]})`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectMachine?.(location);
            }}
          >
            {content}
          </button>
        ) : (
          <span
            key={machineLocationKey(location)}
            className="ade-welcome-chip"
            title={`${machineName} (${DOT_LABEL[dot]})`}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

// A single recents row: project icon, name and path on the left (the open
// button), time and machine chips on the right. Offline remote rows are dimmed
// with a Reconnect affordance; an in-flight connect replaces the path line.
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
  const [localArtwork, setLocalArtwork] = useState(false);
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
  const hasArtwork = Boolean(projectIconDataUrl) || localArtwork;
  // Pin / forget / merge are desktop-recents operations; the hosted client's
  // list is the machines' own catalogs, which it does not own.
  const showRowActions = !connecting && !web;
  const displayPath = welcomeDisplayPath(rp.rootPath);
  const relative = welcomeRelativeTime(lastActiveAt);
  const busyLine = web?.connectStage ?? (connecting && !web ? "Reconnecting…" : null);

  return (
    <div
      className="ade-welcome-row"
      data-ade-stale={web?.stale ? "true" : undefined}
      data-open={isOpen ? "true" : undefined}
      data-dim={!busy && offline ? "true" : undefined}
      data-busy={busy ? "true" : undefined}
      data-has-actions={showRowActions ? "true" : undefined}
      // The time and machine column is part of the row's hit area; its own
      // buttons (chips, row actions) stop propagation.
      onClick={(event) => {
        if (busy) return;
        if ((event.target as HTMLElement).closest("button")) return;
        onOpen();
      }}
    >
      <button
        type="button"
        className="ade-welcome-row-main"
        data-tour="project.recentProject"
        data-welcome-row="true"
        onClick={onOpen}
        disabled={busy}
        aria-current={isOpen ? "page" : undefined}
      >
        <span
          className="ade-welcome-row-icon"
          data-fallback={hasArtwork ? undefined : "true"}
          style={accentColor ? ({ "--row-tint": accentColor } as CSSProperties) : undefined}
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
              onResolved={setLocalArtwork}
            />
          ) : (
            <Folder size={16} weight="regular" />
          )}
        </span>
        <span className="ade-welcome-row-text">
          <span className="ade-welcome-row-name">
            <span>{rp.displayName}</span>
            {!isRemote && rp.worktreeOf ? (
              <WorktreeBadge worktreeOf={rp.worktreeOf} />
            ) : null}
            {rp.pinned ? (
              <PushPin
                className="ade-welcome-row-pin"
                size={11}
                weight="fill"
                aria-label="Pinned"
              />
            ) : null}
          </span>
          {busyLine ? (
            <span className="ade-welcome-row-sub" data-tone="busy">
              <ArrowsClockwise size={11} weight="bold" className="ade-welcome-spin" />
              {busyLine}
            </span>
          ) : (
            <span className="ade-welcome-row-sub">
              <MiddleTruncatedPath path={displayPath} title={rp.rootPath} />
            </span>
          )}
        </span>
      </button>

      <div className="ade-welcome-row-aside">
        <div className="ade-welcome-row-top">
          {isOpen ? (
            <span className="ade-welcome-row-open">
              <span aria-hidden className="ade-welcome-dot" data-state="open" />
              Open
            </span>
          ) : !web && offline && !connecting ? (
            <span className="ade-welcome-row-status">
              <ArrowsClockwise size={11} weight="bold" />
              {parked ? "Resume" : "Reconnect"}
            </span>
          ) : relative ? (
            <span className="ade-welcome-row-time" title={lastActiveAt ?? undefined}>
              {relative}
            </span>
          ) : <span />}
          {showRowActions ? (
            <div className="ade-welcome-row-actions">
              {onMerge && rp.worktreeOf ? (
                <button
                  type="button"
                  className="ade-welcome-icon-button"
                  aria-label={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
                  title={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onMerge();
                  }}
                >
                  <GitMerge size={13} weight="bold" />
                </button>
              ) : null}
              <button
                type="button"
                className="ade-welcome-icon-button"
                aria-label={
                  rp.pinned
                    ? `Unpin ${rp.displayName}`
                    : `Pin ${rp.displayName} to top`
                }
                aria-pressed={rp.pinned ? true : false}
                title={rp.pinned ? "Unpin" : "Pin to top"}
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin();
                }}
              >
                <PushPin size={13} weight={rp.pinned ? "fill" : "regular"} />
              </button>
              <button
                type="button"
                className="ade-welcome-icon-button"
                data-danger="true"
                aria-label={`Remove ${rp.displayName} from recents`}
                title="Remove from recents"
                disabled={isForgetting}
                onClick={(event) => {
                  event.stopPropagation();
                  onForget();
                }}
              >
                <X size={13} weight="bold" />
              </button>
            </div>
          ) : null}
        </div>
        <ProjectMachineChips
          locations={locations}
          primary={primary}
          busy={busy}
          web={web}
          onSelectMachine={onSelectMachine}
        />
      </div>
    </div>
  );
}
