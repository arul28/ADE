import React from "react";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import { ScreenShell } from "./ScreenShell";
import { COLORS, MONO_FONT, SANS_FONT, recessedStyle } from "./shellTokens";

function statusLabel(project: SyncMobileProjectSummary): { text: string; color: string } {
  if (project.isOpen) return { text: "Open", color: COLORS.success };
  if (!project.isAvailable) return { text: "Unavailable", color: COLORS.textMuted };
  return { text: "Available", color: COLORS.textSecondary };
}

/** Lists the connected machine's project catalog so the user can pick one. */
export function ProjectPicker({
  projects,
  machineName,
  onPick,
  onOpenChats,
}: {
  projects: SyncMobileProjectSummary[];
  machineName: string | null;
  onPick: (project: SyncMobileProjectSummary) => void;
  onOpenChats: () => void;
}) {
  const sorted = [...projects].sort((left, right) => {
    if (left.isOpen !== right.isOpen) return left.isOpen ? -1 : 1;
    if (left.isAvailable !== right.isAvailable) return left.isAvailable ? -1 : 1;
    return left.displayName.localeCompare(right.displayName);
  });

  return (
    <ScreenShell
      title="Open a project"
      subtitle={machineName ? `Projects on ${machineName}.` : "Pick a project to open."}
      width={520}
    >
      <button
        type="button"
        onClick={onOpenChats}
        style={recessedStyle({
          display: "grid",
          gap: 3,
          textAlign: "left",
          cursor: "pointer",
          border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)",
          background: "color-mix(in srgb, var(--color-accent) 9%, transparent)",
        })}
      >
        <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
          Chat without a project
        </span>
        <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>
          Use any ADE agent for writing, research, planning, and everyday questions.
        </span>
      </button>
      {sorted.length === 0 ? (
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13 }}>
          This machine has no projects yet. Open a project in ADE desktop, then refresh.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10, maxHeight: "52vh", overflow: "auto" }}>
          {sorted.map((project) => {
            const status = statusLabel(project);
            const disabled = !project.isAvailable && !project.isOpen;
            return (
              <button
                key={project.id}
                type="button"
                disabled={disabled}
                onClick={() => onPick(project)}
                style={recessedStyle({
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 12,
                  alignItems: "center",
                  textAlign: "left",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.55 : 1,
                  border: `1px solid ${COLORS.border}`,
                })}
              >
                <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {project.displayName}
                  </span>
                  {project.rootPath ? (
                    <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {project.rootPath}
                    </span>
                  ) : null}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {project.laneCount > 0 ? (
                    <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
                      {project.laneCount} {project.laneCount === 1 ? "lane" : "lanes"}
                    </span>
                  ) : null}
                  <span style={{ color: status.color, fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600 }}>
                    {status.text}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
}
