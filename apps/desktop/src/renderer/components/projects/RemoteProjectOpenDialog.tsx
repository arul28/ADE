import { type CSSProperties, useEffect } from "react";
import { CloudArrowUp, Desktop, GitBranch, Warning } from "@phosphor-icons/react";
import type {
  RemoteRuntimeLocalWorkCheckResult,
  RemoteRuntimeLocalWorkMatch,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeProjectWorkSummary,
  RemoteRuntimeProjectWorktreeSummary,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

type RemoteProjectOpenDialogProps = {
  project: RemoteRuntimeProjectRecord;
  localWork: RemoteRuntimeLocalWorkCheckResult;
  runtimeName: string;
  busy?: boolean;
  onCancel: () => void;
  onContinue: () => void;
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "rgba(3, 4, 10, 0.76)",
  backdropFilter: "blur(10px)",
  zIndex: 160,
};

const dialogStyle: CSSProperties = {
  width: "min(820px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 48px)",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  background: COLORS.cardBgSolid,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 16,
  boxShadow: "0 30px 100px rgba(0,0,0,0.55)",
  overflow: "hidden",
};

function projectLabel(project: RemoteRuntimeProjectRecord): string {
  return project.displayName || project.rootPath.split(/[\\/]/).filter(Boolean).at(-1) || project.projectId;
}

function shortenPath(path: string): string {
  if (!path) return path;
  const home = path.match(/^\/Users\/([^/]+)/);
  if (home) return path.replace(`/Users/${home[1]}`, "~");
  return path;
}

function shortenOrigin(origin: string | null | undefined): string {
  if (!origin) return "No Git remote";
  return origin
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? `${singular}s`;
}

type Tone = "neutral" | "warn" | "accent";

function chipStyle(tone: Tone, overrides?: CSSProperties): CSSProperties {
  const color =
    tone === "warn"
      ? "var(--color-warning)"
      : tone === "accent"
        ? "var(--color-accent)"
        : "var(--color-fg)";
  const textColor =
    tone === "warn" ? COLORS.warning : tone === "accent" ? COLORS.accent : COLORS.textMuted;
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 7px",
    borderRadius: 999,
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: 500,
    color: textColor,
    background: `color-mix(in srgb, ${color} ${tone === "neutral" ? 7 : 12}%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} ${tone === "neutral" ? 18 : 26}%, transparent)`,
    whiteSpace: "nowrap",
    ...overrides,
  };
}

function StatBlock({
  value,
  label,
  tone = "neutral",
}: {
  value: number | string;
  label: string;
  tone?: Tone;
}) {
  const accent =
    tone === "warn" ? COLORS.warning : tone === "accent" ? COLORS.accent : COLORS.textPrimary;
  return (
    <div
      style={{
        display: "grid",
        gap: 2,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid color-mix(in srgb, ${accent} ${tone === "neutral" ? 8 : 22}%, transparent)`,
        minWidth: 0,
      }}
    >
      <div
        style={{
          color: accent,
          fontFamily: MONO_FONT,
          fontSize: 18,
          fontWeight: 700,
          lineHeight: 1.1,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          fontFamily: SANS_FONT,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function laneChipLabel(lane: RemoteRuntimeProjectWorktreeSummary): string {
  if (lane.isPrimary) return lane.branchName ? `Primary · ${lane.branchName}` : "Primary";
  return lane.branchName ?? lane.name;
}

function ComparisonCard({
  icon,
  kicker,
  title,
  path,
  origin,
  summary,
  tone,
}: {
  icon: React.ReactNode;
  kicker: string;
  title: string;
  path: string;
  origin: string | null;
  summary: RemoteRuntimeProjectWorkSummary | null | undefined;
  tone: "local" | "remote";
}) {
  const accentColor = tone === "local" ? "var(--color-warning)" : "var(--color-accent)";
  const accentText = tone === "local" ? COLORS.warning : COLORS.accent;
  const dirtyLanes = (summary?.lanes ?? []).filter((l) => l.dirtyCount > 0);
  const sortedLanes = [...dirtyLanes].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return b.dirtyCount - a.dirtyCount;
  });
  const visibleLanes = sortedLanes.slice(0, 3);
  const overflow = sortedLanes.length - visibleLanes.length;
  const hasDirty = (summary?.dirtyFileCount ?? 0) > 0;

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        padding: 14,
        borderRadius: 12,
        border: `1px solid color-mix(in srgb, ${accentColor} 22%, ${COLORS.border})`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${accentColor} 6%, rgba(255,255,255,0.02)) 0%, rgba(255,255,255,0.015) 100%)`,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accentColor} 30%, transparent)`,
            color: accentText,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
          <div
            style={{
              color: accentText,
              fontFamily: SANS_FONT,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {kicker}
          </div>
          <div
            style={{
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <div
          title={path}
          style={{
            color: COLORS.textMuted,
            fontFamily: MONO_FONT,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shortenPath(path)}
        </div>
        <div
          title={origin ?? undefined}
          style={{
            color: COLORS.textDim,
            fontFamily: MONO_FONT,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shortenOrigin(origin)}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        <StatBlock value={summary?.laneCount ?? "—"} label="Lanes" />
        <StatBlock
          value={summary?.dirtyFileCount ?? "—"}
          label={pluralize(summary?.dirtyFileCount ?? 0, "Change", "Changes")}
          tone={hasDirty ? "warn" : "neutral"}
        />
        <StatBlock
          value={summary?.dirtyLaneCount ?? "—"}
          label={pluralize(summary?.dirtyLaneCount ?? 0, "Dirty lane", "Dirty lanes")}
          tone={(summary?.dirtyLaneCount ?? 0) > 0 ? "warn" : "neutral"}
        />
      </div>

      {visibleLanes.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 }}>
          {visibleLanes.map((lane) => (
            <span
              key={`${lane.rootPath}:${lane.name}`}
              title={`${laneChipLabel(lane)} — ${lane.dirtyCount} ${pluralize(lane.dirtyCount, "file")}`}
              style={chipStyle(lane.isPrimary ? "warn" : "neutral", {
                maxWidth: "100%",
                overflow: "hidden",
              })}
            >
              <GitBranch size={10} weight="bold" style={{ flexShrink: 0 }} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {laneChipLabel(lane)}
              </span>
              <span style={{ color: COLORS.warning, flexShrink: 0, fontWeight: 600 }}>
                {lane.dirtyCount}
              </span>
            </span>
          ))}
          {overflow > 0 ? (
            <span style={chipStyle("neutral")}>+{overflow} more</span>
          ) : null}
        </div>
      ) : summary ? (
        <div
          style={{
            color: COLORS.textMuted,
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontStyle: "italic",
          }}
        >
          All lanes clean
        </div>
      ) : null}
    </div>
  );
}

function ExtraLocalRow({ match }: { match: RemoteRuntimeLocalWorkMatch }) {
  const dirtyCount = match.workSummary?.dirtyFileCount ?? match.dirtyCount;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
        background: "rgba(255,255,255,0.02)",
        minWidth: 0,
      }}
    >
      <Desktop size={14} weight="duotone" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
      <div style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: COLORS.textPrimary,
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {match.displayName}
        </div>
        <div
          title={match.rootPath}
          style={{
            color: COLORS.textMuted,
            fontFamily: MONO_FONT,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shortenPath(match.rootPath)}
        </div>
      </div>
      {dirtyCount > 0 ? (
        <span style={chipStyle("warn")}>
          {dirtyCount} {pluralize(dirtyCount, "change")}
        </span>
      ) : (
        <span style={chipStyle("neutral")}>clean</span>
      )}
    </div>
  );
}

export function RemoteProjectOpenDialog({
  project,
  localWork,
  runtimeName,
  busy = false,
  onCancel,
  onContinue,
}: RemoteProjectOpenDialogProps) {
  const titleId = "remote-project-open-dialog-title";
  const descriptionId = "remote-project-open-dialog-description";
  const label = projectLabel(project);
  const primaryLocal = localWork.matches[0] ?? null;
  const extraLocal = localWork.matches.slice(1);

  useEffect(() => {
    if (busy) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      role="presentation"
      style={overlayStyle}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
        style={dialogStyle}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: 20,
            borderBottom: `1px solid ${COLORS.border}`,
            background: "linear-gradient(180deg, rgba(24,20,35,0.98) 0%, rgba(24,20,35,0.96) 100%)",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
              color: COLORS.warning,
              flexShrink: 0,
            }}
          >
            <Warning size={18} weight="fill" />
          </div>
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <div
              id={titleId}
              style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 18, fontWeight: 700 }}
            >
              You already work on this repo locally
            </div>
            <div
              id={descriptionId}
              style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.5 }}
            >
              Opening it on <strong style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{runtimeName}</strong>{" "}
              creates a separate remote tab. Your local files and lanes stay exactly where they are.
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, padding: 20, overflow: "auto", minWidth: 0 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 12,
              minWidth: 0,
            }}
          >
            {primaryLocal ? (
              <ComparisonCard
                icon={<Desktop size={16} weight="duotone" />}
                kicker="On this Mac"
                title={primaryLocal.displayName}
                path={primaryLocal.rootPath}
                origin={primaryLocal.gitOriginUrl}
                summary={primaryLocal.workSummary}
                tone="local"
              />
            ) : null}
            <ComparisonCard
              icon={<CloudArrowUp size={16} weight="duotone" />}
              kicker={`On ${runtimeName}`}
              title={label}
              path={project.rootPath}
              origin={localWork.remoteGitOriginUrl}
              summary={localWork.remoteWorkSummary}
              tone="remote"
            />
          </div>

          {extraLocal.length > 0 ? (
            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div
                style={{
                  color: COLORS.textMuted,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {extraLocal.length} more local {pluralize(extraLocal.length, "copy", "copies")} of this repo
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {extraLocal.map((match) => (
                  <ExtraLocalRow key={`${match.rootPath}:${match.gitOriginUrl}`} match={match} />
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: 16,
            borderTop: `1px solid ${COLORS.border}`,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{ ...outlineButton({ height: 34 }), opacity: busy ? 0.55 : 1 }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onContinue}
            style={{ ...primaryButton({ height: 34 }), opacity: busy ? 0.7 : 1 }}
          >
            {busy ? "Opening..." : `Open on ${runtimeName}`}
          </button>
        </div>
      </div>
    </div>
  );
}
