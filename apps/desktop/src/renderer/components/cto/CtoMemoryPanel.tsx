import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarBlank, NotePencil } from "@phosphor-icons/react";

import type { CtoMemorySnapshot } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { CopyButton, CtoCard, TextBlock, ctoButtonStyle } from "./ctoSettingsUi";

/**
 * The CTO's memory, laid out as the things it actually is.
 *
 * The brief is a set of labeled fields, the facts are rows, and each directed
 * thread is a title with the lane it was sent to. The notes file stays
 * editable underneath, because that is the one piece a person still writes.
 */

const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, monospace)";
const BRIEF_LABELS = ["Goal", "Done when", "Constraints", "Conventions", "Open loops"] as const;

/** The files behind this pane, relative to the project. */
const MEMORY_PATHS = [
  { label: "Context", path: ".ade/cto/context-store.json" },
  { label: "Notes", path: ".ade/cto/MEMORY.md" },
  { label: "Working summary", path: ".ade/cto/thread-state.md" },
  { label: "Daily log", path: ".ade/cto/daily/<date>.md" },
];

export type CtoBriefField = { label: (typeof BRIEF_LABELS)[number]; value: string };
export type CtoMemoryFactRow = { status: "pinned" | "active" | "archived"; text: string };
export type CtoDirectedThreadRow = { title: string; lane: string; chat: string; objective: string };

export function parseCtoBrief(text: string): CtoBriefField[] | null {
  const fields: CtoBriefField[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const splitAt = trimmed.indexOf(": ");
    if (splitAt <= 0) return null;
    const label = trimmed.slice(0, splitAt);
    const value = trimmed.slice(splitAt + 2).trim();
    if (!value || !BRIEF_LABELS.includes(label as CtoBriefField["label"])) return null;
    fields.push({ label: label as CtoBriefField["label"], value });
  }
  return fields.length ? fields : null;
}

export function parseCtoMemoryFacts(text: string): CtoMemoryFactRow[] | null {
  const rows: CtoMemoryFactRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^- \((pinned|active|archived)\) (.+)$/.exec(trimmed);
    if (!match) return null;
    rows.push({ status: match[1] as CtoMemoryFactRow["status"], text: match[2] });
  }
  return rows.length ? rows : null;
}

export function parseCtoDirectedThreads(text: string): CtoDirectedThreadRow[] | null {
  const rows: CtoDirectedThreadRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.replace(/^- /, "").split(" · ");
    if (parts.length < 3 || !parts[1]?.startsWith("lane ") || !parts[2]?.startsWith("chat ")) return null;
    rows.push({
      title: parts[0],
      lane: parts[1].slice("lane ".length),
      chat: parts[2].slice("chat ".length),
      objective: parts.slice(3).join(" · "),
    });
  }
  return rows.length ? rows : null;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function EmptyLine({ children }: { children: string }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "12px 14px",
        borderRadius: 10,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 12,
        lineHeight: 1.5,
        color: COLORS.textMuted,
      }}
    >
      {children}
    </p>
  );
}

function CountChip({ children }: { children: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 8px",
        borderRadius: 999,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textMuted,
      }}
    >
      {children}
    </span>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <span
      style={{
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: COLORS.textMuted,
      }}
    >
      {children}
    </span>
  );
}

function BriefFields({ fields, accent }: { fields: CtoBriefField[]; accent: string }) {
  const goal = fields.find((field) => field.label === "Goal");
  const rest = fields.filter((field) => field.label !== "Goal");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {goal ? (
        <div
          style={{
            display: "grid",
            gap: 6,
            padding: "12px 14px",
            borderRadius: 12,
            background: `color-mix(in srgb, ${accent} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 28%, transparent)`,
          }}
        >
          <FieldLabel>Goal</FieldLabel>
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 14, lineHeight: 1.45, fontWeight: 600, color: COLORS.textPrimary }}>
            {goal.value}
          </p>
        </div>
      ) : null}
      {rest.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
          {rest.map((field) => (
            <div
              key={field.label}
              style={{
                display: "grid",
                gap: 4,
                minWidth: 0,
                padding: "10px 12px",
                borderRadius: 10,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
              }}
            >
              <FieldLabel>{field.label}</FieldLabel>
              <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12.5, lineHeight: 1.5, color: COLORS.textSecondary }}>
                {field.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_LABEL = { pinned: "Pinned", active: "Active", archived: "Archived" } as const;

function FactList({ rows, accent }: { rows: CtoMemoryFactRow[]; accent: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, 6);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {shown.map((row) => (
        <div
          key={`${row.status}:${row.text}`}
          style={{
            display: "grid",
            gridTemplateColumns: "72px minmax(0, 1fr)",
            gap: 10,
            alignItems: "start",
            padding: "8px 10px",
            borderRadius: 10,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
          }}
        >
          <span
            style={{
              justifySelf: "start",
              padding: "2px 7px",
              borderRadius: 999,
              fontFamily: SANS_FONT,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: row.status === "pinned" ? accent : COLORS.textMuted,
              background: row.status === "pinned" ? `color-mix(in srgb, ${accent} 14%, transparent)` : "transparent",
              border: `1px solid ${row.status === "pinned" ? `color-mix(in srgb, ${accent} 32%, transparent)` : COLORS.borderMuted}`,
            }}
          >
            {STATUS_LABEL[row.status]}
          </span>
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12.5, lineHeight: 1.5, color: COLORS.textPrimary }}>
            {row.text}
          </p>
        </div>
      ))}
      {rows.length > 6 ? (
        <button type="button" onClick={() => setOpen((value) => !value)} style={{ ...ctoButtonStyle(), justifySelf: "start", height: 26 }}>
          {open ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

function ThreadList({ rows }: { rows: CtoDirectedThreadRow[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, 5);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {shown.map((row) => (
        <article
          key={`${row.chat}:${row.title}`}
          style={{
            display: "grid",
            gap: 4,
            padding: "10px 12px",
            borderRadius: 10,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
          }}
        >
          <h4 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
            {row.title}
          </h4>
          {row.objective ? (
            <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45, color: COLORS.textSecondary }}>
              {row.objective}
            </p>
          ) : null}
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
            Lane {row.lane}
            <span aria-hidden> · </span>
            Chat {row.chat}
          </p>
        </article>
      ))}
      {rows.length > 5 ? (
        <button type="button" onClick={() => setOpen((value) => !value)} style={{ ...ctoButtonStyle(), justifySelf: "start", height: 26 }}>
          {open ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function CtoMemoryPanel({ accent = "#34D399" }: { accent?: string } = {}) {
  const [snapshot, setSnapshot] = useState<CtoMemorySnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [notesFocused, setNotesFocused] = useState(false);

  const load = useCallback(async () => {
    const bridge = window.ade?.cto;
    if (!bridge?.getMemory) {
      setLoading(false);
      return;
    }
    try {
      const next = await bridge.getMemory();
      setSnapshot(next);
      setDraft(next.memory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = snapshot != null && draft !== snapshot.memory;

  const handleSave = useCallback(async () => {
    const bridge = window.ade?.cto;
    if (!bridge?.updateMemory) return;
    setSaving(true);
    setError(null);
    try {
      const next = await bridge.updateMemory({ memory: draft });
      setSnapshot(next);
      setDraft(next.memory);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save memory.");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const savedRecently = useMemo(() => savedAt != null && Date.now() - savedAt < 4000, [savedAt]);
  const updated = relativeTime(snapshot?.updatedAt ?? null);
  const brief = snapshot?.projectBrief?.trim() ? parseCtoBrief(snapshot.projectBrief.trim()) : null;
  const facts = snapshot?.projectItems?.trim() ? parseCtoMemoryFacts(snapshot.projectItems.trim()) : null;
  const threads = snapshot?.projectThreads?.trim() ? parseCtoDirectedThreads(snapshot.projectThreads.trim()) : null;

  if (loading) {
    return (
      <p style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>Loading memory…</p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} data-testid="cto-memory-panel">
      <CtoCard
        title="Project brief"
        description="One brief for this repository. The CTO writes it."
        accent={accent}
        testId="cto-memory-brief"
      >
        {snapshot?.projectBrief?.trim() ? (
          brief ? <BriefFields fields={brief} accent={accent} /> : <TextBlock text={snapshot.projectBrief.trim()} mono={false} />
        ) : (
          <EmptyLine>No brief yet. The CTO writes the goal, what done looks like, and the constraints.</EmptyLine>
        )}
      </CtoCard>

      <CtoCard
        title="What the CTO knows"
        description="Facts it saved for the project. They stay after a restart or a cleared session."
        accent={accent}
        testId="cto-memory-items"
        right={facts ? <CountChip>{facts.length === 1 ? "1 fact" : `${facts.length} facts`}</CountChip> : null}
      >
        {snapshot?.projectItems?.trim() ? (
          facts ? <FactList rows={facts} accent={accent} /> : <TextBlock text={snapshot.projectItems.trim()} collapsedHeight={180} mono={false} />
        ) : (
          <EmptyLine>Nothing saved yet.</EmptyLine>
        )}
      </CtoCard>

      <CtoCard
        title="Threads the CTO directed"
        description="Chats it started so the work has its own lane."
        accent={accent}
        testId="cto-memory-threads"
        right={threads ? <CountChip>{threads.length === 1 ? "1 thread" : `${threads.length} threads`}</CountChip> : null}
      >
        {snapshot?.projectThreads?.trim() ? (
          threads ? <ThreadList rows={threads} /> : <TextBlock text={snapshot.projectThreads.trim()} collapsedHeight={160} mono={false} />
        ) : (
          <EmptyLine>No threads yet.</EmptyLine>
        )}
      </CtoCard>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <CtoCard
          title="Working summary"
          description="Written as the work moves."
          accent={accent}
          testId="cto-memory-summary"
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {updated ? (
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                  Updated {updated}
                </span>
              ) : null}
              {snapshot?.threadState?.trim() ? <CopyButton value={snapshot.threadState.trim()} /> : null}
            </div>
          }
        >
          {snapshot?.threadState?.trim() ? (
            <TextBlock text={snapshot.threadState.trim()} mono={false} />
          ) : (
            <EmptyLine>Nothing yet. The CTO writes this once it has work to summarise.</EmptyLine>
          )}
        </CtoCard>

        <CtoCard
          title="Daily log"
          description="What it did today."
          accent={accent}
          testId="cto-memory-daily"
          right={
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textMuted,
              }}
            >
              <CalendarBlank size={12} />
              {snapshot?.dailyLogDate ?? "—"}
            </span>
          }
        >
          {snapshot?.dailyLog?.trim() ? (
            <TextBlock text={snapshot.dailyLog.trim()} collapsedHeight={160} />
          ) : (
            <EmptyLine>Nothing logged today.</EmptyLine>
          )}
        </CtoCard>
      </div>

      <CtoCard
        title="Notes"
        description="A local file. The brief and facts above are the copy that follows the account."
        accent={accent}
        testId="cto-memory-notes"
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {savedRecently && !dirty ? (
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.success }}>Saved</span>
            ) : null}
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
              style={{
                ...ctoButtonStyle(dirty && !saving ? "primary" : "quiet"),
                cursor: dirty && !saving ? "pointer" : "default",
                opacity: dirty || saving ? 1 : 0.5,
              }}
            >
              <NotePencil size={12} />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        <textarea
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setNotesFocused(true)}
          onBlur={() => setNotesFocused(false)}
          placeholder="# Durable facts&#10;- Decisions, preferences, and standing context the CTO should always know."
          style={{
            width: "100%",
            maxWidth: 720,
            minHeight: 150,
            maxHeight: 340,
            resize: "vertical",
            background: COLORS.recessedBg,
            border: `1px solid ${notesFocused ? accent : COLORS.borderMuted}`,
            borderRadius: 10,
            padding: 12,
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.7,
            color: COLORS.textPrimary,
            outline: "none",
            transition: "border-color 140ms ease",
          }}
        />
      </CtoCard>

      <CtoCard
        title="Where it lives"
        description="Local on this machine. The context file follows the ADE account when the repo has a remote."
        accent={accent}
        testId="cto-memory-paths"
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {MEMORY_PATHS.map((entry) => (
            <span
              key={entry.path}
              title={entry.path}
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 8,
                maxWidth: "100%",
                padding: "6px 10px",
                borderRadius: 999,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
              }}
            >
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{entry.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textSecondary }}>{entry.path}</span>
            </span>
          ))}
        </div>
      </CtoCard>

      {error ? (
        <p role="alert" style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
