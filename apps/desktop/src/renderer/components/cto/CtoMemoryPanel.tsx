import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarBlank, NotePencil } from "@phosphor-icons/react";

import type { CtoMemorySnapshot } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { CopyButton, CtoCard, FactRow, TextBlock, ctoButtonStyle } from "./ctoSettingsUi";

/**
 * The CTO's memory, as four things rather than one wall.
 *
 * It is four different objects with four different rules — one the user writes,
 * one the CTO writes, one the day writes, and the files underneath — and
 * printing them as one column of text made them look like one undifferentiated
 * dump. Each gets a card, an icon and a sentence saying who writes it.
 */

const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, monospace)";

/** The files behind this pane, relative to the project. */
const MEMORY_PATHS = [
  { label: "Notes", path: ".ade/cto/MEMORY.md" },
  { label: "Working summary", path: ".ade/cto/thread-state.md" },
  { label: "Daily log", path: ".ade/cto/daily/<date>.md" },
];

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

export function CtoMemoryPanel({ accent = "#34D399" }: { accent?: string } = {}) {
  const [snapshot, setSnapshot] = useState<CtoMemorySnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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

  if (loading) {
    return (
      <p style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>Loading memory…</p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} data-testid="cto-memory-panel">
      <CtoCard
        title="Notes the CTO keeps"
        description="You write these. The CTO reads them back on every turn, and they survive a model switch."
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
          placeholder="# Durable facts&#10;- Decisions, preferences, and standing context the CTO should always know."
          style={{
            width: "100%",
            maxWidth: 720,
            minHeight: 150,
            maxHeight: 340,
            resize: "vertical",
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: 10,
            padding: 12,
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.7,
            color: COLORS.textPrimary,
            outline: "none",
          }}
        />
      </CtoCard>

      <CtoCard
        title="Working summary"
        description="The CTO writes this as the work moves. You cannot edit it."
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
          <TextBlock text={snapshot.threadState.trim()} />
        ) : (
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
            Nothing yet. The CTO writes this once it has work to summarise.
          </p>
        )}
      </CtoCard>

      <CtoCard
        title="Daily log"
        description="What the CTO did today, written as it happens."
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
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
            Nothing logged today.
          </p>
        )}
      </CtoCard>

      <CtoCard title="Where it lives" accent={accent} testId="cto-memory-paths">
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)",
            gap: "6px 16px",
            margin: 0,
          }}
        >
          {MEMORY_PATHS.map((entry) => (
            <FactRow key={entry.path} label={entry.label} value={entry.path} mono title={entry.path} />
          ))}
        </dl>
      </CtoCard>

      {error ? (
        <p role="alert" style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
