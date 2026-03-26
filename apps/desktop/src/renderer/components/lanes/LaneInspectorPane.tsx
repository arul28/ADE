import { useCallback, useState } from "react";
import { LanePrPanel } from "../prs/LanePrPanel";
import { LaneConflictsPanel } from "./LaneConflictsPanel";
import { COLORS, MONO_FONT } from "./laneDesignTokens";
import { useAppStore } from "../../state/appStore";

type InspectorTab = "pr" | "conflicts";
type EditorTarget = "vscode" | "cursor" | "zed";

const TAB_DEFS: Array<{ id: InspectorTab; num: string; label: string }> = [
  { id: "pr", num: "01", label: "PR" },
  { id: "conflicts", num: "02", label: "CONFLICTS" },
];

const EDITOR_OPTIONS: Array<{ target: EditorTarget; label: string }> = [
  { target: "vscode", label: "VS Code" },
  { target: "cursor", label: "Cursor" },
  { target: "zed", label: "Zed" },
];

export function LaneInspectorPane({
  laneId,
  defaultTab
}: {
  laneId: string | null;
  defaultTab?: InspectorTab;
}) {
  const [tab, setTab] = useState<InspectorTab>(defaultTab ?? "pr");
  const lanes = useAppStore((s) => s.lanes);
  const lane = laneId ? lanes.find((l) => l.id === laneId) : null;

  const openInEditor = useCallback(
    (target: EditorTarget) => {
      if (!lane?.worktreePath) return;
      void window.ade.app.openPathInEditor({ rootPath: lane.worktreePath, target });
    },
    [lane?.worktreePath],
  );

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      <div
        className="flex items-center shrink-0"
        style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg, gap: 8 }}
        role="tablist"
        aria-label="Inspector tabs"
      >
        {TAB_DEFS.map((def) => {
          const isActive = tab === def.id;
          return (
            <button
              key={def.id}
              id={`inspector-tab-${def.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`inspector-tabpanel-${def.id}`}
              className="relative flex items-center transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                fontWeight: isActive ? 600 : 500,
                textTransform: "uppercase",
                letterSpacing: "1px",
                padding: "10px 16px",
                gap: 8,
                ...(isActive
                  ? {
                      background: `${COLORS.accent}18`,
                      borderLeft: `2px solid ${COLORS.accent}`,
                      color: COLORS.textPrimary,
                    }
                  : {
                      background: "transparent",
                      borderLeft: "2px solid transparent",
                      color: COLORS.textMuted,
                    }),
              }}
              onClick={() => setTab(def.id)}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textSecondary;
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textMuted;
              }}
            >
              <span style={{ color: isActive ? COLORS.accent : COLORS.textDim }}>{def.num}</span>
              <span>{def.label}</span>
            </button>
          );
        })}
        {lane?.worktreePath ? (
          <div className="ml-auto flex items-center" style={{ gap: 4, paddingRight: 8 }}>
            {EDITOR_OPTIONS.map((editor) => (
              <button
                key={editor.target}
                type="button"
                title={`Open in ${editor.label}`}
                data-testid={`lane-open-${editor.target}`}
                className="transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  padding: "4px 8px",
                  minHeight: 28,
                  background: "transparent",
                  border: `1px solid ${COLORS.border}`,
                  color: COLORS.textMuted,
                  cursor: "pointer",
                }}
                onClick={() => openInEditor(editor.target)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = COLORS.textPrimary;
                  e.currentTarget.style.borderColor = COLORS.accent;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = COLORS.textMuted;
                  e.currentTarget.style.borderColor = COLORS.border;
                }}
              >
                {editor.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex-1 min-h-0" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {tab === "pr" && (
          <div id="inspector-tabpanel-pr" role="tabpanel" aria-labelledby="inspector-tab-pr" className="h-full overflow-auto">
            <LanePrPanel laneId={laneId} />
          </div>
        )}
        {tab === "conflicts" && (
          <div id="inspector-tabpanel-conflicts" role="tabpanel" aria-labelledby="inspector-tab-conflicts" className="h-full overflow-auto">
            <LaneConflictsPanel laneId={laneId} />
          </div>
        )}
      </div>
    </div>
  );
}
