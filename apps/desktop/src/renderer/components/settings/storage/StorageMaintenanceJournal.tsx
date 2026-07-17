import React from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type {
  MaintenanceRunReport,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PANEL_STYLE } from "./storageUiConstants";
import { journalEntries, maintenanceActionLines, maintenanceHeadline } from "./storageView";

export function MaintenanceJournal({ extras }: { extras: StorageSnapshotExtras | undefined }) {
  const runs = React.useMemo(() => journalEntries(extras, 8), [extras]);
  const [expanded, setExpanded] = React.useState(false);
  if (runs.length === 0) return null;

  return (
    <section style={{ ...PANEL_STYLE, display: "flex", flexDirection: "column", gap: expanded ? 12 : 0 }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          fontWeight: 650,
          color: COLORS.textPrimary,
        }}
      >
        {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
        Recent cleanups
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500, color: COLORS.textMuted }}>{runs.length}</span>
      </button>

      {expanded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {runs.map((run, index) => (
            <JournalRow key={`${run.startedAt}-${index}`} run={run} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function JournalRow({ run }: { run: MaintenanceRunReport }) {
  const lines = maintenanceActionLines(run).filter((line) => line.detail !== "nothing to do");
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${COLORS.borderMuted}`,
        background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
      }}
    >
      <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
        {maintenanceHeadline(run)}
      </div>
      {lines.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 14px", marginTop: 6 }}>
          {lines.map((line, index) => (
            <span
              key={`${line.ledgerId}-${index}`}
              style={{ fontFamily: SANS_FONT, fontSize: 11, color: line.failed ? COLORS.warning : COLORS.textMuted }}
            >
              {line.label} · {line.detail}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
