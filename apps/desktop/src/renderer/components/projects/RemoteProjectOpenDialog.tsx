import { type CSSProperties, useEffect } from "react";
import { Warning } from "@phosphor-icons/react";
import type { RemoteRuntimeLocalWorkCheckResult, RemoteRuntimeProjectRecord } from "../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

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
  width: "min(620px, calc(100vw - 32px))",
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

function formatChangedFileCount(count: number): string {
  return `${count} changed ${count === 1 ? "file" : "files"}`;
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
            <div id={titleId} style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 18, fontWeight: 700 }}>
              Local work found
            </div>
            <div id={descriptionId} style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.45 }}>
              ADE found local copies of {label} with uncommitted changes. Opening {runtimeName} switches ADE to the remote project and leaves those local files untouched.
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, padding: 20, overflow: "auto" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <div style={LABEL_STYLE}>Remote project</div>
            <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, wordBreak: "break-word" }}>
              {project.rootPath}
            </div>
            <div style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 11, wordBreak: "break-all" }}>
              {localWork.remoteGitOriginUrl ?? "No origin advertised by the remote project"}
            </div>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={LABEL_STYLE}>Local copies with uncommitted work</div>
            {localWork.matches.map((match) => (
              <div
                key={`${match.rootPath}:${match.gitOriginUrl}`}
                style={{
                  display: "grid",
                  gap: 5,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: "rgba(255,255,255,0.025)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700, minWidth: 0 }}>
                    {match.displayName}
                  </div>
                  <div
                    style={{
                      flexShrink: 0,
                      color: COLORS.warning,
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      padding: "3px 7px",
                      borderRadius: 6,
                      background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--color-warning) 26%, transparent)",
                    }}
                  >
                    {formatChangedFileCount(match.dirtyCount)}
                  </div>
                </div>
                <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11, wordBreak: "break-word" }}>
                  {match.rootPath}
                </div>
                <div style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 11, wordBreak: "break-all" }}>
                  {match.gitOriginUrl}
                </div>
              </div>
            ))}
          </div>
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
          <button type="button" disabled={busy} onClick={onCancel} style={{ ...outlineButton({ height: 34 }), opacity: busy ? 0.55 : 1 }}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onContinue} style={{ ...primaryButton({ height: 34 }), opacity: busy ? 0.7 : 1 }}>
            {busy ? "Opening..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
