import type { ProjectSecretsImportPreview } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Dialog } from "../ui/dialog";

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
  const saveDisabled = importing || selectedNames.size === 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !importing) onClose();
      }}
      // JSX title so the × keeps its exact "Close import secrets" label.
      title={<>Import secrets from {preview.fileName}</>}
      description="Review the extracted values and choose which ADE secrets to save."
      closeLabel="Close import secrets"
      width={760}
      maxHeight="min(760px, calc(100vh - 40px))"
      dismissible={!importing}
      preventAutoFocus
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column", marginTop: 14, fontFamily: SANS_FONT }}
      footerStart={error ? <div role="alert" style={{ color: "#dc2626", fontSize: 12 }}>{error}</div> : undefined}
      actions={[
        { label: "Cancel", onClick: onClose, disabled: importing, variant: "secondary" },
        {
          label: importing ? "Saving…" : `Save ${selectedNames.size} secret${selectedNames.size === 1 ? "" : "s"}`,
          onClick: onSave,
          disabled: saveDisabled,
          variant: "solid",
        },
      ]}
      tone="accent"
    >
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

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "8px 20px" }}>
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
    </Dialog>
  );
}
