import React from "react";
import { Key, Check, Copy, DownloadSimple, Eye, EyeSlash, Plus, Trash, UploadSimple, X } from "@phosphor-icons/react";
import type {
  ProjectSecretStorage,
  ProjectSecretsImportPreview,
  ProjectSecretsListResult,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { relativeTimeCompact } from "../../lib/format";
import { SecretsImportEnvModal } from "./SecretsImportEnvModal";
import {
  SettingsColumn,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSplit,
} from "./primitives";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

/** The anchor `secrets.secrets` in `settingsManifest.ts` points at. */
const ANCHOR = "secrets";

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** "2m ago", "3d ago"; the exact time is in the tooltip. */
function updatedLabel(value: string): string {
  const compact = relativeTimeCompact(value);
  if (!compact) return "";
  return compact === "now" ? "just now" : `${compact} ago`;
}

export function SecretsSection() {
  const [snapshot, setSnapshot] = React.useState<ProjectSecretsListResult | null>(null);
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [storage, setStorage] = React.useState<ProjectSecretStorage>("account");
  const [revealedValues, setRevealedValues] = React.useState<Record<string, string>>({});
  const [visibleNames, setVisibleNames] = React.useState<Record<string, boolean>>({});
  // Keyed so only the row that was copied shows its confirmation. The hook
  // reports a failed write as `false` rather than rethrowing, so the transport
  // stashes the underlying IPC message for `copySecret` to surface.
  const copyErrorRef = React.useRef<string | null>(null);
  const { copy: copyToClipboard, isCopied, copiedKey: copiedName, reset: resetCopied } = useCopyToClipboard({
    write: async (value) => {
      copyErrorRef.current = null;
      try {
        await window.ade.app.writeClipboardText(value);
        return true;
      } catch (err) {
        copyErrorRef.current = err instanceof Error ? err.message : String(err);
        return false;
      }
    },
  });
  const [confirmDeleteName, setConfirmDeleteName] = React.useState<string | null>(null);
  const [busyName, setBusyName] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [choosingImport, setChoosingImport] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [confirmingExport, setConfirmingExport] = React.useState(false);
  const [importPreview, setImportPreview] = React.useState<ProjectSecretsImportPreview | null>(null);
  const [selectedImportNames, setSelectedImportNames] = React.useState<Set<string>>(new Set());
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
      await window.ade.projectSecrets.set({ name: nextName, value, storage });
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
      // The hook reports a failed write as `false` rather than throwing, so the
      // success message must be gated on it — otherwise a denied clipboard
      // still tells the user the secret was copied.
      const copiedOk = await copyToClipboard(secretValue, secretName);
      if (!copiedOk) {
        const reason = copyErrorRef.current;
        setError(`Couldn't copy ${secretName} to the clipboard.${reason ? ` ${reason}` : ""}`);
        return;
      }
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
      if (copiedName === secretName) resetCopied();
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
      const changedNames = [...result.imported, ...result.replaced];
      setVisibleNames((current) => {
        const next = { ...current };
        for (const changedName of changedNames) delete next[changedName];
        return next;
      });
      setRevealedValues((current) => {
        const next = { ...current };
        for (const changedName of changedNames) delete next[changedName];
        return next;
      });
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
    if (!confirmingExport) {
      setConfirmingExport(true);
      setMessage(null);
      setError(null);
      return;
    }
    setConfirmingExport(false);
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
  const canAdd = !saving && Boolean(name.trim()) && Boolean(value);

  const list = (
    // One-line headings on both sides, so the two panels start level.
    <SettingsSection
      title="Saved secrets"
      actions={<span className="ade-settings-summary">{secrets.length} saved · encrypted</span>}
    >
      <div className="ade-settings-panel">
        {secrets.length === 0 ? (
          <div className="ade-settings-row" style={{ padding: "36px 16px", textAlign: "center" }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 500, color: COLORS.textPrimary }}>No secrets yet</div>
            <div style={{ marginTop: 4, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
              Add one on the right, or import a .env file.
            </div>
          </div>
        ) : (
          secrets.map((secret) => {
            const isVisible = Boolean(visibleNames[secret.name]);
            const isBusy = busyName === secret.name;
            const isConfirmingDelete = confirmDeleteName === secret.name;
            const rowCopied = isCopied(secret.name);
            const revealed = revealedValues[secret.name];
            return (
              <div key={secret.name} className="ade-settings-row ade-secret-row">
                <span aria-hidden className="ade-settings-row-icon" style={{ ["--tone" as string]: "#F5A524" } as React.CSSProperties}>
                  <Key size={15} weight="duotone" />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={secret.name}
                  >
                    {secret.name}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontFamily: isVisible && revealed != null ? MONO_FONT : SANS_FONT,
                      fontSize: 12,
                      color: isVisible && revealed != null ? COLORS.textSecondary : COLORS.textDim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isVisible && revealed != null
                      ? revealed
                      : `${"•".repeat(Math.min(Math.max(secret.valueLength, 8), 12))}  ${secret.valueLength} characters`}
                  </div>
                </div>
                <span className="ade-settings-chip">{secret.storage === "account" ? "Account" : "This device"}</span>
                <span
                  style={{ width: 74, textAlign: "right", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim, flexShrink: 0 }}
                  title={formatUpdatedAt(secret.updatedAt)}
                >
                  {updatedLabel(secret.updatedAt)}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="ade-settings-ghost-icon"
                    title={isVisible ? "Hide value" : "Show value"}
                    aria-label={isVisible ? `Hide ${secret.name}` : `Reveal ${secret.name}`}
                    disabled={isBusy}
                    onClick={() => void toggleReveal(secret.name)}
                  >
                    {isVisible ? <EyeSlash size={15} /> : <Eye size={15} />}
                  </button>
                  <button
                    type="button"
                    className="ade-settings-ghost-icon"
                    data-tone={rowCopied ? "success" : undefined}
                    title={rowCopied ? "Copied" : "Copy value"}
                    aria-label={rowCopied ? `Copied ${secret.name}` : `Copy ${secret.name}`}
                    disabled={isBusy}
                    onClick={() => void copySecret(secret.name)}
                  >
                    {rowCopied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
                  </button>
                  {isConfirmingDelete ? (
                    <button
                      type="button"
                      className="ade-settings-button"
                      data-variant="danger"
                      style={{ height: 28, padding: "0 10px" }}
                      aria-label={`Confirm delete ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void deleteSecret(secret.name)}
                    >
                      Delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ade-settings-ghost-icon"
                      data-tone="danger"
                      title="Delete secret"
                      aria-label={`Delete ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void deleteSecret(secret.name)}
                    >
                      <Trash size={15} />
                    </button>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </SettingsSection>
  );

  const side = (
    <>
      <SettingsSection title="Add a secret">
        <form onSubmit={handleSave} className="ade-settings-panel" style={{ padding: 16, gap: 14 }}>
          <label className="ade-settings-field">
            <span>Name</span>
            <input
              className="ade-settings-input"
              data-mono=""
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="STRIPE_API_KEY"
              aria-label="Secret name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="ade-settings-field">
            <span>Value</span>
            <input
              className="ade-settings-input"
              data-mono=""
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste the value"
              aria-label="Secret value"
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div className="ade-settings-field">
            <span>Save to</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <SettingsSegmented
                ariaLabel="Secret storage"
                value={storage}
                onChange={setStorage}
                options={[
                  { value: "account", label: "Account" },
                  { value: "device", label: "This device only" },
                ]}
              />
              <button type="submit" className="ade-settings-button" data-variant="primary" disabled={!canAdd}>
                <Plus size={13} weight="bold" />
                {saving ? "Saving…" : "Add secret"}
              </button>
            </div>
            <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45, color: COLORS.textDim }}>
              {storage === "account"
                ? "Follows your account to every machine that opens this repository."
                : "Stays on this computer only."}
            </p>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title=".env files">
        <SettingsPanel>
          <SettingsRow
            icon={<UploadSimple size={15} weight="duotone" />}
            tone="blue"
            title="Import"
            description="Choose which keys to add from a .env file on this computer."
            control={
              <button type="button" className="ade-settings-button" aria-label="Import .env" disabled={choosingImport} onClick={() => void chooseEnvFile()}>
                {choosingImport ? "Opening…" : "Import…"}
              </button>
            }
          />
          <SettingsRow
            icon={<DownloadSimple size={15} weight="duotone" />}
            tone={confirmingExport ? "red" : "orange"}
            title="Export"
            description={
              confirmingExport
                ? "Writes every value unencrypted to Downloads. Click again to confirm."
                : "Writes every value, unencrypted, to a .env file in Downloads."
            }
            control={
              <button
                type="button"
                className="ade-settings-button"
                data-variant={confirmingExport ? "danger" : undefined}
                aria-label={confirmingExport ? "Confirm plaintext export" : "Export .env"}
                disabled={exporting || secrets.length === 0}
                onClick={() => void exportSecrets()}
              >
                {exporting ? "Exporting…" : confirmingExport ? "Confirm export" : "Export"}
              </button>
            }
          />
        </SettingsPanel>
      </SettingsSection>
    </>
  );

  return (
    <SettingsColumn wide>
      <div id={ANCHOR} data-settings-anchor={ANCHOR} className="ade-settings-split-stack" style={{ scrollMarginTop: 16 }}>
        {(message || error) && (
          <div role={error ? "alert" : "status"} className="ade-settings-note" style={{ color: error ? COLORS.danger : COLORS.success }}>
            {error ? <X size={14} weight="bold" /> : <Check size={14} weight="bold" />}
            <span>{error ?? message}</span>
          </div>
        )}
        <SettingsSplit ratio="start-wide" start={list} end={side} />
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
    </SettingsColumn>
  );
}
