import React from "react";
import { Check, Copy, DownloadSimple, Eye, EyeSlash, Key, Plus, Trash, UploadSimple, X } from "@phosphor-icons/react";
import type { ProjectSecretSummary, ProjectSecretsImportPreview, ProjectSecretsListResult } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SecretsImportEnvModal } from "./SecretsImportEnvModal";
import { SettingsSectionShell } from "./settingsSectionUi";

const inputStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 8,
  background: "var(--color-card)",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 12,
  minHeight: 34,
  padding: "8px 10px",
  outline: "none",
};

const iconButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: "var(--color-card)",
  color: COLORS.textSecondary,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function SecretValueCell({
  secret,
  value,
  visible,
}: {
  secret: ProjectSecretSummary;
  value: string | null;
  visible: boolean;
}) {
  const displayValue = visible && value != null ? value : "*".repeat(Math.min(Math.max(secret.valueLength, 8), 24));
  return (
    <code
      style={{
        display: "block",
        maxWidth: "min(38vw, 420px)",
        minHeight: 28,
        padding: "6px 8px",
        borderRadius: 8,
        border: `1px solid ${COLORS.outlineBorder}`,
        background: "color-mix(in srgb, var(--color-card) 72%, var(--color-bg))",
        color: visible ? COLORS.textPrimary : COLORS.textMuted,
        fontSize: 12,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {displayValue}
    </code>
  );
}

export function SecretsSection() {
  const [snapshot, setSnapshot] = React.useState<ProjectSecretsListResult | null>(null);
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [revealedValues, setRevealedValues] = React.useState<Record<string, string>>({});
  const [visibleNames, setVisibleNames] = React.useState<Record<string, boolean>>({});
  const [copiedName, setCopiedName] = React.useState<string | null>(null);
  const [confirmDeleteName, setConfirmDeleteName] = React.useState<string | null>(null);
  const [busyName, setBusyName] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [choosingImport, setChoosingImport] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [importPreview, setImportPreview] = React.useState<ProjectSecretsImportPreview | null>(null);
  const [selectedImportNames, setSelectedImportNames] = React.useState<Set<string>>(new Set());
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const copyResetTimerRef = React.useRef<number | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const next = await window.ade.projectSecrets.list();
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => () => {
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const markCopied = React.useCallback((secretName: string) => {
    setCopiedName(secretName);
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedName((current) => current === secretName ? null : current);
      copyResetTimerRef.current = null;
    }, 1500);
  }, []);

  const fetchSecretValue = React.useCallback(async (secretName: string, cache: boolean): Promise<string> => {
    const cached = revealedValues[secretName];
    if (cache && cached != null) return cached;
    const result = await window.ade.projectSecrets.get({ name: secretName });
    if (cache) {
      setRevealedValues((current) => ({ ...current, [secretName]: result.value }));
    }
    return result.value;
  }, [revealedValues]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || !value) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await window.ade.projectSecrets.set({ name: nextName, value });
      setValue("");
      setName("");
      setConfirmDeleteName(null);
      setVisibleNames((current) => ({ ...current, [nextName]: false }));
      setRevealedValues((current) => {
        const next = { ...current };
        delete next[nextName];
        return next;
      });
      setMessage(`Saved ${nextName}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = async (secretName: string) => {
    if (visibleNames[secretName]) {
      setVisibleNames((current) => ({ ...current, [secretName]: false }));
      setRevealedValues((current) => {
        const next = { ...current };
        delete next[secretName];
        return next;
      });
      return;
    }
    setBusyName(secretName);
    setError(null);
    try {
      await fetchSecretValue(secretName, true);
      setVisibleNames((current) => ({ ...current, [secretName]: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  const copySecret = async (secretName: string) => {
    setBusyName(secretName);
    setError(null);
    setMessage(null);
    try {
      const secretValue = revealedValues[secretName] ?? await fetchSecretValue(secretName, false);
      await window.ade.app.writeClipboardText(secretValue);
      markCopied(secretName);
      setMessage(`Copied ${secretName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  const deleteSecret = async (secretName: string) => {
    if (confirmDeleteName !== secretName) {
      setConfirmDeleteName(secretName);
      return;
    }
    setBusyName(secretName);
    setError(null);
    setMessage(null);
    try {
      await window.ade.projectSecrets.delete({ name: secretName, confirmName: secretName });
      setConfirmDeleteName(null);
      setCopiedName((current) => current === secretName ? null : current);
      setVisibleNames((current) => {
        const next = { ...current };
        delete next[secretName];
        return next;
      });
      setRevealedValues((current) => {
        const next = { ...current };
        delete next[secretName];
        return next;
      });
      setMessage(`Deleted ${secretName}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  const chooseEnvFile = async () => {
    setChoosingImport(true);
    setMessage(null);
    setError(null);
    try {
      const preview = await window.ade.projectSecrets.chooseEnvFile();
      if (!preview) return;
      setImportPreview(preview);
      setImportError(null);
      setSelectedImportNames(new Set(preview.secrets.map((secret) => secret.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChoosingImport(false);
    }
  };

  const importSelectedSecrets = async () => {
    if (!importPreview || selectedImportNames.size === 0) return;
    setImporting(true);
    setImportError(null);
    setMessage(null);
    setError(null);
    try {
      const result = await window.ade.projectSecrets.importEnv({
        secrets: importPreview.secrets
          .filter((secret) => selectedImportNames.has(secret.name))
          .map(({ name: secretName, value: secretValue }) => ({ name: secretName, value: secretValue })),
      });
      const total = result.imported.length + result.replaced.length;
      setImportPreview(null);
      setSelectedImportNames(new Set());
      setMessage(`Imported ${total} secret${total === 1 ? "" : "s"}${result.replaced.length ? ` (${result.replaced.length} replaced)` : ""}.`);
      await load();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const exportSecrets = async () => {
    setExporting(true);
    setMessage(null);
    setError(null);
    try {
      const result = await window.ade.projectSecrets.exportEnv();
      setMessage(`Exported ${result.secretCount} secret${result.secretCount === 1 ? "" : "s"} to ${result.filePath} on the active machine.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const secrets = snapshot?.secrets ?? [];

  return (
    <SettingsSectionShell
      title="Secrets"
      description="Encrypted project secrets for ADE agents, desktop, and CLI."
      icon={Key}
      brandColor="#2563eb"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18, fontFamily: SANS_FONT }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ color: COLORS.textMuted, fontSize: 12, lineHeight: 1.5 }}>
            Import reads a file from this Mac. Export writes to Downloads on the machine hosting this project.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={choosingImport}
              onClick={() => void chooseEnvFile()}
              style={{ ...inputStyle, display: "inline-flex", alignItems: "center", gap: 6, cursor: choosingImport ? "not-allowed" : "pointer", opacity: choosingImport ? 0.55 : 1 }}
            >
              <UploadSimple size={14} />
              {choosingImport ? "Opening…" : "Import .env"}
            </button>
            <button
              type="button"
              disabled={exporting || secrets.length === 0}
              onClick={() => void exportSecrets()}
              style={{ ...inputStyle, display: "inline-flex", alignItems: "center", gap: 6, cursor: exporting || secrets.length === 0 ? "not-allowed" : "pointer", opacity: exporting || secrets.length === 0 ? 0.55 : 1 }}
            >
              <DownloadSimple size={14} />
              {exporting ? "Exporting…" : "Export .env"}
            </button>
          </div>
        </div>
        <form
          onSubmit={handleSave}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            alignItems: "center",
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="STRIPE_API_KEY"
            aria-label="Secret name"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={inputStyle}
          />
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Secret value"
            aria-label="Secret value"
            type="password"
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={saving || !name.trim() || !value}
            style={{
              minHeight: 34,
              borderRadius: 8,
              border: "none",
              background: COLORS.accent,
              color: "white",
              fontFamily: SANS_FONT,
              fontSize: 12,
              fontWeight: 700,
              padding: "0 12px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              cursor: saving || !name.trim() || !value ? "not-allowed" : "pointer",
              opacity: saving || !name.trim() || !value ? 0.55 : 1,
              whiteSpace: "nowrap",
            }}
          >
            <Plus size={14} weight="bold" />
            {saving ? "Saving" : "Add secret"}
          </button>
        </form>

        {(message || error) && (
          <div
            role={error ? "alert" : "status"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: error ? "#dc2626" : "#15803d",
              fontSize: 12,
              minHeight: 18,
            }}
          >
            {error ? <X size={14} weight="bold" /> : <Check size={14} weight="bold" />}
            <span>{error ?? message}</span>
          </div>
        )}

        <div
          style={{
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            overflowX: "auto",
            background: "var(--color-card)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(160px, 1fr) minmax(180px, 1.4fr) minmax(140px, 0.9fr) 132px",
              gap: 12,
              alignItems: "center",
              padding: "9px 12px",
              minWidth: 680,
              borderBottom: `1px solid ${COLORS.outlineBorder}`,
              color: COLORS.textMuted,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0,
            }}
          >
            <span>Name</span>
            <span>Value</span>
            <span>Updated</span>
            <span>Actions</span>
          </div>
          {secrets.length === 0 ? (
            <div style={{ padding: 18, color: COLORS.textMuted, fontSize: 12 }}>
              No secrets saved.
            </div>
          ) : (
            secrets.map((secret) => {
              const isVisible = Boolean(visibleNames[secret.name]);
              const isBusy = busyName === secret.name;
              const isConfirmingDelete = confirmDeleteName === secret.name;
              const isCopied = copiedName === secret.name;
              return (
                <div
                  key={secret.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(160px, 1fr) minmax(180px, 1.4fr) minmax(140px, 0.9fr) 132px",
                    gap: 12,
                    alignItems: "center",
                    padding: "10px 12px",
                    minWidth: 680,
                    borderTop: `1px solid ${COLORS.outlineBorder}`,
                    minHeight: 54,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: COLORS.textPrimary, fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {secret.name}
                    </div>
                    <div style={{ color: COLORS.textMuted, fontSize: 11 }}>
                      {secret.valueLength} chars
                    </div>
                  </div>
                  <SecretValueCell secret={secret} value={revealedValues[secret.name] ?? null} visible={isVisible} />
                  <div style={{ color: COLORS.textMuted, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {formatUpdatedAt(secret.updatedAt)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                    <button
                      type="button"
                      title={isVisible ? "Hide secret" : "Reveal secret"}
                      aria-label={isVisible ? `Hide ${secret.name}` : `Reveal ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void toggleReveal(secret.name)}
                      style={{ ...iconButtonStyle, opacity: isBusy ? 0.5 : 1 }}
                    >
                      {isVisible ? <EyeSlash size={15} /> : <Eye size={15} />}
                    </button>
                    <button
                      type="button"
                      title={isCopied ? "Copied" : "Copy secret"}
                      aria-label={isCopied ? `Copied ${secret.name}` : `Copy ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void copySecret(secret.name)}
                      style={{
                        ...iconButtonStyle,
                        color: isCopied ? "#15803d" : COLORS.textSecondary,
                        borderColor: isCopied ? "color-mix(in srgb, #15803d 42%, transparent)" : COLORS.outlineBorder,
                        background: isCopied ? "color-mix(in srgb, #15803d 12%, var(--color-card))" : "var(--color-card)",
                        opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {isCopied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
                    </button>
                    <button
                      type="button"
                      title={isConfirmingDelete ? "Confirm delete" : "Delete secret"}
                      aria-label={isConfirmingDelete ? `Confirm delete ${secret.name}` : `Delete ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void deleteSecret(secret.name)}
                      style={{
                        ...iconButtonStyle,
                        width: isConfirmingDelete ? 72 : 30,
                        color: isConfirmingDelete ? "white" : "#dc2626",
                        background: isConfirmingDelete ? "#dc2626" : "var(--color-card)",
                        borderColor: isConfirmingDelete ? "#dc2626" : COLORS.outlineBorder,
                        opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {isConfirmingDelete ? "Confirm" : <Trash size={15} />}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {importPreview && (
        <SecretsImportEnvModal
          preview={importPreview}
          selectedNames={selectedImportNames}
          importing={importing}
          error={importError}
          onSelectionChange={setSelectedImportNames}
          onClose={() => {
            if (importing) return;
            setImportPreview(null);
            setImportError(null);
            setSelectedImportNames(new Set());
          }}
          onSave={() => void importSelectedSecrets()}
        />
      )}
    </SettingsSectionShell>
  );
}
