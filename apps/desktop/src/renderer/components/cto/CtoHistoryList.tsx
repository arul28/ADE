import React, { useMemo } from "react";

import type { CtoSessionLogEntry } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { ModelRowLogo } from "../shared/ProviderLogos";

/**
 * Every session the CTO has run here, as a list you can scan.
 *
 * Two things made the old one unreadable: the row led with the log line
 * ("Session closed: …"), which is the machine's sentence and not the work's,
 * and every row carried a `FULL_TOOLING` chip — a raw enum, shown loudest on
 * the rows where it meant "nothing unusual happened".
 */

/** Log lines are prefixed by whoever wrote them; the title is what is left. */
const LOG_PREFIX = /^(session\s+(closed|ended|started)|closed|ended)\s*[:\-—]\s*/i;

export function sessionTitle(entry: CtoSessionLogEntry): string {
  const summary = (entry.summary ?? "").trim();
  const stripped = summary.replace(LOG_PREFIX, "").trim();
  if (!stripped) return "Untitled session";
  // What is left of "Session closed: reviewed the queue" starts mid-sentence.
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", else "Sep 12". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Null while a session is still open — there is no duration to state yet. */
export function sessionDuration(entry: CtoSessionLogEntry): string | null {
  if (!entry.endedAt) return null;
  const started = new Date(entry.startedAt).getTime();
  const ended = new Date(entry.endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  const seconds = Math.round((ended - started) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function Meta({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: width ? "flex-end" : undefined,
        gap: 5,
        width,
        flexShrink: 0,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textMuted,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SessionRow({ entry, onOpen }: { entry: CtoSessionLogEntry; onOpen?: (entry: CtoSessionLogEntry) => void }) {
  const model = entry.modelId ? getModelById(entry.modelId) : undefined;
  const duration = sessionDuration(entry);
  const title = sessionTitle(entry);
  const interactive = Boolean(onOpen);
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onOpen?.(entry) : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onOpen?.(entry);
            }
          : undefined
      }
      data-testid="cto-history-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 12px",
        borderRadius: 10,
        cursor: interactive ? "pointer" : "default",
        minWidth: 0,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = COLORS.hoverBg; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          color: COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={title}
      >
        {title}
      </span>

      {model ? (
        <Meta>
          <ModelRowLogo
            modelFamily={model.family}
            cliCommand={model.cliCommand}
            modelId={model.id}
            providerModelId={model.providerModelId}
            {...(model.openCodeProviderId ? { openCodeProviderId: model.openCodeProviderId } : {})}
            size={12}
          />
          {model.displayName}
        </Meta>
      ) : null}

      {/* Only when it is NOT the ordinary case: a chip on every row that says
          "normal" is a chip that says nothing. */}
      {entry.capabilityMode === "fallback" ? <Meta>Limited tools</Meta> : null}

      {/* Fixed, right-aligned so the numbers form columns down the list
          instead of drifting with the width of whatever is beside them. */}
      <Meta width={52}>{duration ?? ""}</Meta>
      <Meta width={62}>{relativeTime(entry.createdAt)}</Meta>
    </div>
  );
}

export function CtoHistoryList({
  sessions,
  onOpen,
}: {
  sessions: CtoSessionLogEntry[];
  onOpen?: (entry: CtoSessionLogEntry) => void;
}) {
  const groups = useMemo(() => {
    const now = new Date();
    const byDay = new Map<string, CtoSessionLogEntry[]>();
    for (const entry of sessions) {
      const label = dayLabel(entry.createdAt, now);
      const bucket = byDay.get(label);
      if (bucket) bucket.push(entry);
      else byDay.set(label, [entry]);
    }
    return [...byDay.entries()];
  }, [sessions]);

  if (sessions.length === 0) {
    return (
      <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
        The CTO has not run a session in this project yet.
      </p>
    );
  }

  return (
    <div data-testid="session-history-list" style={{ display: "grid", gap: 18 }}>
      {groups.map(([label, entries]) => (
        <section key={label} style={{ minWidth: 0 }}>
          <h3
            style={{
              margin: "0 0 4px",
              padding: "0 12px",
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: COLORS.textDim,
            }}
          >
            {label}
          </h3>
          <div style={{ display: "grid" }}>
            {entries.map((entry) => (
              <SessionRow key={entry.id} entry={entry} {...(onOpen ? { onOpen } : {})} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
