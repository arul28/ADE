import React from "react";
import { CaretDown } from "@phosphor-icons/react";
import type {
  MaintenanceRunReport,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import { journalEntries, maintenanceActionLines, maintenanceHeadline } from "./storageView";

export function MaintenanceJournal({ extras }: { extras: StorageSnapshotExtras | undefined }) {
  const runs = React.useMemo(() => journalEntries(extras, 8), [extras]);
  const [expanded, setExpanded] = React.useState(false);
  if (runs.length === 0) return null;

  return (
    <div className="ade-modern-rows">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="ade-pj-disclosure-btn"
      >
        <CaretDown size={12} weight="bold" className="ade-pj-caret" data-open={expanded || undefined} />
        <span className="ade-pj-disclosure-title">Recent cleanups</span>
        <span className="ade-pj-disclosure-sub kit-num">{runs.length}</span>
      </button>

      {expanded ? (
        <div className="ade-st-journal">
          {runs.map((run, index) => (
            <JournalRow key={`${run.startedAt}-${index}`} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JournalRow({ run }: { run: MaintenanceRunReport }) {
  const lines = maintenanceActionLines(run).filter((line) => line.detail !== "nothing to do");
  return (
    <div className="ade-st-journal-row">
      <div className="ade-st-item-label">{maintenanceHeadline(run)}</div>
      {lines.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 14px", marginTop: 4 }}>
          {lines.map((line, index) => (
            <span
              key={`${line.ledgerId}-${index}`}
              className="ade-st-item-detail"
              style={line.failed ? { color: "var(--kit-warn)" } : undefined}
            >
              {line.label} · {line.detail}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
