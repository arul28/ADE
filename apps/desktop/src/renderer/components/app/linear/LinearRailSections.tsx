import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  CircleDashed,
  FileText,
  Funnel,
  Target,
} from "@phosphor-icons/react";
import type {
  CtoLinearCycle,
  CtoLinearDocument,
  CtoLinearFavorite,
  CtoLinearInitiative,
  CtoLinearRailData,
  OpenProjectBinding,
} from "../../../../shared/types";
import { LinearProjectIcon, resolveLinearProjectIcon } from "../../lanes/linearProjectIcon";
import { cn } from "../../ui/cn";
import { openExternalUrl } from "./adeStatus";

/**
 * The Linear rail's workspace sections: Favorites, Cycles, Initiatives and
 * Documents. Each hides when empty, and the whole block renders nothing when
 * Linear has none of them (the common case), so an empty workspace costs no
 * pixels. Read once per Linear machine and team, kept in a module cache, and
 * read again only when the window comes back after a minute away. No polling;
 * a failed or missing read (an older machine) shows nothing.
 */

const REFRESH_AFTER_MS = 60_000;
const FAVORITES_SHOWN = 10;
const COLLAPSE_STORAGE_KEY = "ade.linear.railSections.collapsed.v1";

type RailEntry = {
  data: CtoLinearRailData | null;
  fetchedAt: number;
  promise: Promise<void> | null;
};

const railCache = new Map<string, RailEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const ctoScopes = new WeakMap<object, number>();
let nextCtoScope = 1;

/** A different bridge object (tests, a reconnected web client) gets its own entries. */
function ctoScope(): string {
  const cto = window.ade?.cto as object | undefined;
  if (!cto) return "none";
  let scope = ctoScopes.get(cto);
  if (!scope) {
    scope = nextCtoScope++;
    ctoScopes.set(cto, scope);
  }
  return String(scope);
}

function railKey(pinKey: string, teamKey: string | null): string {
  return `${pinKey}::team:${teamKey ?? "*"}::cto:${ctoScope()}`;
}

function loadRail(key: string, pin: OpenProjectBinding, teamKey: string | null, force = false): void {
  const read = window.ade?.cto?.getLinearRailData;
  if (typeof read !== "function") return;
  const current = railCache.get(key);
  if (current?.promise) return;
  if (!force && current?.data && Date.now() - current.fetchedAt < REFRESH_AFTER_MS) return;
  const promise = Promise.resolve()
    .then(() => read({ teamKey }, pin))
    .then((data) => {
      railCache.set(key, { data: data ?? null, fetchedAt: Date.now(), promise: null });
    })
    .catch(() => {
      // Keep what was shown; a failed read renders nothing new and no banner.
      const entry = railCache.get(key);
      railCache.set(key, { data: entry?.data ?? null, fetchedAt: Date.now(), promise: null });
    })
    .finally(notify);
  railCache.set(key, { data: current?.data ?? null, fetchedAt: current?.fetchedAt ?? 0, promise });
}

function readCollapsed(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeCollapsed(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Not saved: the choice still holds while the pane is open.
  }
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function RailRow({
  active,
  icon,
  title,
  trailing,
  tooltip,
  onClick,
}: {
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
  tooltip?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:bg-fg/[0.05]",
        active ? "bg-fg/[0.06] text-fg" : "text-muted-fg/80 hover:bg-fg/[0.04] hover:text-fg",
      )}
      aria-current={active ? "true" : undefined}
      title={tooltip ?? title}
      onClick={onClick}
    >
      <span className="grid w-[15px] shrink-0 place-items-center text-muted-fg/70">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px]">{title}</span>
      {trailing ? <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">{trailing}</span> : null}
    </button>
  );
}

function RailSection({
  id,
  title,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3" data-linear-rail={id}>
      <button
        type="button"
        className="group/section mb-1 flex w-full items-center gap-1 rounded px-2 text-left text-[11px] text-muted-fg/50 outline-none transition-colors hover:text-muted-fg/80 focus-visible:text-fg"
        aria-expanded={!collapsed}
        onClick={() => onToggle(id)}
      >
        <span>{title}</span>
        <CaretRight
          size={9}
          weight="bold"
          aria-hidden
          className={cn(
            "opacity-0 transition-[transform,opacity] duration-150 group-hover/section:opacity-100 group-focus-visible/section:opacity-100",
            !collapsed && "rotate-90",
            collapsed && "opacity-100",
          )}
        />
      </button>
      {collapsed ? null : <div className="space-y-px">{children}</div>}
    </div>
  );
}

/** Linear's cycle ring: a thin track with a pie filled to the share of scope done. */
function CycleProgressRing({ progress, size = 14 }: { progress: number | null; size?: number }) {
  const value = Math.max(0, Math.min(1, progress ?? 0));
  // A pie drawn as a stroke as wide as its own diameter: radius 2.5, width 5.
  const pieRadius = 2.5;
  const pieLength = 2 * Math.PI * pieRadius;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeOpacity={0.45} strokeWidth={1.25} />
      {value > 0 ? (
        <circle
          cx="7"
          cy="7"
          r={pieRadius}
          fill="none"
          stroke="currentColor"
          strokeWidth={pieRadius * 2}
          strokeDasharray={`${(value * pieLength).toFixed(2)} ${pieLength.toFixed(2)}`}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  );
}

function EntityIcon({ icon, color, fallback }: { icon: string | null; color: string | null; fallback: React.ReactNode }) {
  const glyph = resolveLinearProjectIcon(icon);
  if (glyph) return <span className="text-[12px] leading-none" aria-hidden>{glyph}</span>;
  return <span style={color ? { color } : undefined} className="grid place-items-center">{fallback}</span>;
}

// ── Favorites ───────────────────────────────────────────────────────────────

const FAVORITE_SCOPE_PREFIX: Record<string, string> = {
  project: "project:",
  customView: "view:",
  view: "view:",
  cycle: "cycle:",
  label: "label:",
  initiative: "initiative:",
  document: "document:",
};

function favoriteIcon(favorite: CtoLinearFavorite): React.ReactNode {
  switch (favorite.type) {
    case "project":
      return <LinearProjectIcon icon={favorite.icon} color={favorite.color} name={favorite.title} size={14} />;
    case "customView":
    case "view":
      return <Funnel size={13} style={favorite.color ? { color: favorite.color } : undefined} />;
    case "cycle":
      return <CycleProgressRing progress={null} size={13} />;
    case "label":
      return <span className="block h-[8px] w-[8px] rounded-full" style={{ backgroundColor: favorite.color ?? "var(--color-muted-fg)" }} />;
    case "initiative":
      return <EntityIcon icon={favorite.icon} color={favorite.color} fallback={<Target size={13} />} />;
    case "document":
      return <EntityIcon icon={favorite.icon} color={favorite.color} fallback={<FileText size={13} />} />;
    case "issue":
      return <CircleDashed size={13} />;
    default:
      return <EntityIcon icon={favorite.icon} color={favorite.color} fallback={<ArrowSquareOut size={12} />} />;
  }
}

function favoriteScope(favorite: CtoLinearFavorite): string | null {
  const prefix = FAVORITE_SCOPE_PREFIX[favorite.type];
  return prefix && favorite.targetId ? `${prefix}${favorite.targetId}` : null;
}

// ── Cycles ──────────────────────────────────────────────────────────────────

function cycleTitle(cycle: CtoLinearCycle, showTeam: boolean): string {
  const name = cycle.name?.trim() || `Cycle ${cycle.number}`;
  return showTeam ? `${cycle.teamKey} ${name}` : name;
}

function cycleWhen(cycle: CtoLinearCycle): string {
  if (cycle.isActive) return "Current";
  if (cycle.isNext) return "Next";
  if (cycle.isPrevious) return "Previous";
  return formatShortDate(cycle.startsAt);
}

function orderedCycles(cycles: CtoLinearCycle[]): CtoLinearCycle[] {
  const rank = (cycle: CtoLinearCycle) => (cycle.isActive ? 0 : cycle.isNext ? 1 : cycle.isPrevious ? 2 : 3);
  return cycles
    .filter((cycle) => cycle.isActive || cycle.isNext || cycle.isPrevious)
    .sort((a, b) => a.teamKey.localeCompare(b.teamKey) || rank(a) - rank(b));
}

// ── The sections ────────────────────────────────────────────────────────────

export function LinearRailSections({
  pin,
  teamKey,
  activeScope,
  onSelectScope,
  onOpenIssue,
}: {
  pin: OpenProjectBinding | null;
  teamKey: string | null;
  activeScope: string;
  onSelectScope: (scope: string) => void;
  onOpenIssue: (issueIdOrIdentifier: string) => void;
}): JSX.Element | null {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const supported = typeof window !== "undefined" && typeof window.ade?.cto?.getLinearRailData === "function";
  const key = pinKey && supported ? railKey(pinKey, teamKey) : null;
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? railCache.get(key) ?? null : null),
    () => null,
  );

  useEffect(() => {
    if (!key || !pinRef.current) return undefined;
    loadRail(key, pinRef.current, teamKey);
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !pinRef.current) return;
      loadRail(key, pinRef.current, teamKey);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key, teamKey]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      writeCollapsed(next);
      return next;
    });
  }, []);
  const [showAllFavorites, setShowAllFavorites] = useState(false);

  const data = entry?.data ?? null;
  const favorites = useMemo(
    () => (data?.favorites ?? []).filter((favorite) => favorite.type !== "folder").slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [data],
  );
  const cycles = useMemo(() => orderedCycles(data?.cycles ?? []), [data]);
  const showCycleTeam = useMemo(() => new Set(cycles.map((cycle) => cycle.teamKey)).size > 1, [cycles]);
  const initiatives: CtoLinearInitiative[] = data?.initiatives ?? [];
  const documents: CtoLinearDocument[] = data?.documents ?? [];

  if (!data || (favorites.length === 0 && cycles.length === 0 && initiatives.length === 0 && documents.length === 0)) {
    return null;
  }

  const openFavorite = (favorite: CtoLinearFavorite) => {
    if (favorite.type === "issue" && favorite.targetId) {
      onOpenIssue(favorite.targetId);
      return;
    }
    const scope = favoriteScope(favorite);
    if (scope) onSelectScope(scope);
    else if (favorite.url) openExternalUrl(favorite.url);
  };
  const shownFavorites = showAllFavorites ? favorites : favorites.slice(0, FAVORITES_SHOWN);

  return (
    <div data-linear-rail="workspace">
      {favorites.length > 0 ? (
        <RailSection id="favorites" title="Favorites" collapsed={collapsed.favorites === true} onToggle={toggle}>
          {shownFavorites.map((favorite) => {
            const scope = favoriteScope(favorite);
            return (
              <RailRow
                key={favorite.id}
                active={scope != null && scope === activeScope}
                icon={favoriteIcon(favorite)}
                title={favorite.title || "Untitled"}
                onClick={() => openFavorite(favorite)}
              />
            );
          })}
          {favorites.length > FAVORITES_SHOWN ? (
            <button
              type="button"
              className="flex h-7 w-full items-center rounded-md px-2 pl-[31px] text-left text-[11px] text-muted-fg/50 transition-colors hover:bg-fg/[0.04] hover:text-fg"
              onClick={() => setShowAllFavorites((value) => !value)}
            >
              {showAllFavorites ? "Show fewer" : `Show ${favorites.length - FAVORITES_SHOWN} more`}
            </button>
          ) : null}
        </RailSection>
      ) : null}

      {cycles.length > 0 ? (
        <RailSection id="cycles" title="Cycles" collapsed={collapsed.cycles === true} onToggle={toggle}>
          {cycles.map((cycle) => {
            const dates = `${formatShortDate(cycle.startsAt)} – ${formatShortDate(cycle.endsAt)}`;
            const progress = cycle.progress != null ? `, ${Math.round(cycle.progress * 100)}% done` : "";
            return (
              <RailRow
                key={cycle.id}
                active={activeScope === `cycle:${cycle.id}`}
                icon={<CycleProgressRing progress={cycle.progress} />}
                title={cycleTitle(cycle, showCycleTeam)}
                trailing={cycleWhen(cycle)}
                tooltip={`${cycleTitle(cycle, true)}: ${dates}${progress}`}
                onClick={() => onSelectScope(`cycle:${cycle.id}`)}
              />
            );
          })}
        </RailSection>
      ) : null}

      {initiatives.length > 0 ? (
        <RailSection id="initiatives" title="Initiatives" collapsed={collapsed.initiatives === true} onToggle={toggle}>
          {initiatives.map((initiative) => (
            <RailRow
              key={initiative.id}
              active={activeScope === `initiative:${initiative.id}`}
              icon={<EntityIcon icon={initiative.icon} color={initiative.color} fallback={<Target size={13} />} />}
              title={initiative.name}
              trailing={initiative.status ?? undefined}
              tooltip={[initiative.name, initiative.status, initiative.targetDate ? `Target ${formatShortDate(initiative.targetDate)}` : null]
                .filter(Boolean)
                .join(", ")}
              onClick={() => onSelectScope(`initiative:${initiative.id}`)}
            />
          ))}
        </RailSection>
      ) : null}

      {documents.length > 0 ? (
        <RailSection id="documents" title="Documents" collapsed={collapsed.documents === true} onToggle={toggle}>
          {documents.map((document) => (
            <RailRow
              key={document.id}
              active={activeScope === `document:${document.id}`}
              icon={<EntityIcon icon={document.icon} color={document.color} fallback={<FileText size={13} />} />}
              title={document.title || "Untitled document"}
              trailing={formatShortDate(document.updatedAt)}
              tooltip={[document.title, document.projectName].filter(Boolean).join(", ")}
              onClick={() => onSelectScope(`document:${document.id}`)}
            />
          ))}
        </RailSection>
      ) : null}
    </div>
  );
}
