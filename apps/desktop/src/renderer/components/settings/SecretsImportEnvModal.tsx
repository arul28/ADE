import React from "react";
import { X } from "@phosphor-icons/react";
import type { ProjectSecretsImportPreview } from "../../../shared/types";
import { useDialogFocusTrap } from "../app/HeaderSheet";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 34,
  padding: "8px 10px",
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 8,
  background: "var(--color-card)",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 12,
};

export function SecretsImportEnvModal({
  preview,
  selectedNames,
  importing,
  error,
  onSelectionChange,
  onClose,
  onSave,
}: {
  preview: ProjectSecretsImportPreview;
  selectedNames: Set<string>;
  importing: boolean;
  error: string | null;
  onSelectionChange: (next: Set<string>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const allSelected = selectedNames.size === preview.secrets.length;
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const closeIfIdle = React.useCallback(() => {
    if (!importing) onClose();
  }, [importing, onClose]);
  const handleKeyDown = useDialogFocusTrap(dialogRef, closeIfIdle, true);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 220,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0, 0, 0, 0.58)",
        backdropFilter: "blur(8px)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !importing) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-env-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          display: "flex",
          flexDirection: "column",
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 12,
          overflow: "hidden",
          background: "var(--color-bg)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
          fontFamily: SANS_FONT,
        }}
      >
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "18px 20px", borderBottom: `1px solid ${COLORS.outlineBorder}` }}>
          <div>
            <h2 id="import-env-title" style={{ margin: 0, color: COLORS.textPrimary, fontSize: 16 }}>
              Import secrets from {preview.fileName}
            </h2>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontSize: 12 }}>
              Review the extracted values and choose which ADE secrets to save.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close import secrets"
            disabled={importing}
            onClick={onClose}
            style={{ ...secondaryButtonStyle, width: 30, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: importing ? 0.5 : 1 }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 20px", borderBottom: `1px solid ${COLORS.outlineBorder}` }}>
          <span style={{ color: COLORS.textMuted, fontSize: 12 }}>
            {selectedNames.size} of {preview.secrets.length} selected
          </span>
          <button
            type="button"
            onClick={() => onSelectionChange(allSelected ? new Set() : new Set(preview.secrets.map((secret) => secret.name)))}
            style={{ border: "none", background: "transparent", color: COLORS.accent, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "8px 20px" }}>
          {preview.secrets.map((secret) => {
            const checked = selectedNames.has(secret.name);
            return (
              <label
                key={secret.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px minmax(150px, 0.8fr) minmax(220px, 1.4fr)",
                  gap: 12,
                  alignItems: "start",
                  padding: "12px 0",
                  borderTop: `1px solid ${COLORS.outlineBorder}`,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Set(selectedNames);
                    if (checked) next.delete(secret.name);
                    else next.add(secret.name);
                    onSelectionChange(next);
                  }}
                  style={{ marginTop: 5, accentColor: COLORS.accent }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: COLORS.textPrimary, fontSize: 12, fontWeight: 700, overflowWrap: "anywhere" }}>{secret.name}</div>
                  {secret.exists && <div style={{ marginTop: 4, color: "#d97706", fontSize: 10, fontWeight: 700 }}>Replaces existing</div>}
                </div>
                <code style={{ padding: "7px 9px", borderRadius: 8, border: `1px solid ${COLORS.outlineBorder}`, background: "var(--color-card)", color: COLORS.textPrimary, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {secret.value}
                </code>
              </label>
            );
          })}
        </div>

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px", borderTop: `1px solid ${COLORS.outlineBorder}` }}>
          {error && <div role="alert" style={{ marginRight: "auto", alignSelf: "center", color: "#dc2626", fontSize: 12 }}>{error}</div>}
          <button type="button" disabled={importing} onClick={onClose} style={{ ...secondaryButtonStyle, cursor: importing ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button
            type="button"
            disabled={importing || selectedNames.size === 0}
            onClick={onSave}
            style={{ minHeight: 34, border: "none", borderRadius: 8, padding: "0 14px", background: COLORS.accent, color: "white", fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, cursor: importing || selectedNames.size === 0 ? "not-allowed" : "pointer", opacity: importing || selectedNames.size === 0 ? 0.55 : 1 }}
          >
            {importing ? "Saving…" : `Save ${selectedNames.size} secret${selectedNames.size === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
