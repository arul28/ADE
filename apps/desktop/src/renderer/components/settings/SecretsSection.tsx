import React from "react";
import { Check, CloudArrowDown, Copy, DownloadSimple, Eye, EyeSlash, Key, MagnifyingGlass, Plus, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import type {
  ProjectSecretStorage,
  ProjectSecretSummary,
  ProjectSecretsImportPreview,
  ProjectSecretsListResult,
} from "../../../shared/types";
import { projectSecretPullSummary } from "../../../shared/projectSecretPullSummary";
import { relativeTimeCompact } from "../../lib/format";
import { SecretsImportEnvModal } from "./SecretsImportEnvModal";
import { ModernRow, ModernRows, ModernSection, SettingsColumn } from "./primitives";
import "./SecretsSection.css";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

/** The anchor `secrets.secrets` in `settingsManifest.ts` points at. */
const ANCHOR = "secrets";

/** Waits between re-reads while a row still says "Uploading"; then it stays. */
const UPLOAD_RECHECK_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];

function storageLabel(secret: ProjectSecretSummary): string {
  if (secret.storage !== "account") return "This device";
  return secret.uploadPending ? "Uploading" : "Account";
}

/**
 * What to say after a save whose requested scope could not be honoured.
 *
 * The backend reports where the value actually went. When that is not where the
 * person asked for, saying only "Saved" is the lie this sentence exists to
 * avoid: the row would look shared and never be shared.
 */
function savedMessage(name: string, requested: ProjectSecretStorage, actual: ProjectSecretStorage): string {
  if (requested === actual) return `Saved ${name}.`;
  return `Saved ${name} for this device only. Your account vault is not reachable, so this value stays on this machine and will not follow you to another one.`;
}

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
  const [pulling, setPulling] = React.useState(false);
  const [confirmingExport, setConfirmingExport] = React.useState(false);
  const [importPreview, setImportPreview] = React.useState<ProjectSecretsImportPreview | null>(null);
  const [selectedImportNames, setSelectedImportNames] = React.useState<Set<string>>(new Set());
  const [message, setMessage] = React.useState<string | null>(null);
  const [noteTone, setNoteTone] = React.useState<"success" | "warning">("success");
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);

  /** The inline note carries a tone: a degraded outcome is not a success. */
  const note = React.useCallback((text: string, tone: "success" | "warning" = "success") => {
    setNoteTone(tone);
    setMessage(text);
  }, []);

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

  // A saved account secret uploads within a second; look again a few times,
  // further apart each time, so "Uploading" turns into "Account" without a
  // reload — and stays visible when the upload is genuinely stuck. Each
  // `load()` sets a new snapshot, which re-runs this effect for the next delay.
  const uploadPending = Boolean(snapshot?.secrets.some((secret) => secret.uploadPending));
  const uploadRecheckRef = React.useRef(0);
  React.useEffect(() => {
    if (!uploadPending) {
      uploadRecheckRef.current = 0;
      return;
    }
    const delay = UPLOAD_RECHECK_DELAYS_MS[uploadRecheckRef.current];
    if (delay === undefined) return;
    const timer = window.setTimeout(() => {
      uploadRecheckRef.current += 1;
      void load();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [uploadPending, snapshot, load]);

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
      const saved = await window.ade.projectSecrets.set({ name: nextName, value, storage });
      setValue("");
      setName("");
      setConfirmDeleteName(null);
      setVisibleNames((current) => ({ ...current, [nextName]: false }));
      setRevealedValues((current) => {
        const next = { ...current };
        delete next[nextName];
        return next;
      });
      // A new save starts the "Uploading" re-checks over.
      uploadRecheckRef.current = 0;
      await load();
      note(savedMessage(nextName, storage, saved.storage), storage === saved.storage ? "success" : "warning");
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
      note(`Copied ${secretName}.`);
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
      note(`Deleted ${secretName}.`);
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
      note(`Imported ${total} secret${total === 1 ? "" : "s"}${result.replaced.length ? ` (${result.replaced.length} replaced)` : ""}.`);
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
      note(`Exported ${result.secretCount} secret${result.secretCount === 1 ? "" : "s"} to ${result.filePath} on the active machine.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const secrets = snapshot?.secrets ?? [];
  const canAdd = !saving && Boolean(name.trim()) && Boolean(value);

  const pullFromAccount = async () => {
    setPulling(true);
    setMessage(null);
    setError(null);
    try {
      const result = await window.ade.projectSecrets.pullFromAccount();
      note(projectSecretPullSummary(result), result.state === "unavailable" ? "warning" : "success");
      // A pull can replace a value this section already revealed and cached, so
      // drop every revealed value, reveal toggle and copy confirmation with it.
      setRevealedValues({});
      setVisibleNames({});
      resetCopied();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPulling(false);
    }
  };

  const query = search.trim().toLowerCase();
  const shownSecrets = query ? secrets.filter((secret) => secret.name.toLowerCase().includes(query)) : secrets;

  const list = (
    <ModernSection
      group="Secrets"
      title="Saved secrets"
      hint={`${secrets.length} saved · encrypted`}
      actions={(
        <>
          {secrets.length > 0 ? (
            <label className="ade-secrets-search">
              <MagnifyingGlass size={13} aria-hidden />
              <input
                type="search"
                className="ade-modern-field"
                placeholder="Filter"
                aria-label="Filter secrets"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                spellCheck={false}
              />
            </label>
          ) : null}
          <button
            type="button"
            className="ade-modern-btn"
            data-variant="ghost"
            title="Take the account-stored secrets this repository has in the vault onto this machine"
            aria-label="Pull from account"
            onClick={() => {
              if (!pulling) void pullFromAccount();
            }}
          >
            <CloudArrowDown size={13} />
            {pulling ? "Pulling…" : "Pull from account"}
          </button>
          <button type="button" className="ade-modern-btn" data-tone="primary" onClick={() => nameInputRef.current?.focus()}>
            <Plus size={12} weight="bold" /> New
          </button>
        </>
      )}
    >
      <div className="ade-modern-rows ade-secrets-table" {...(secrets.length > 0 ? { role: "table", "aria-label": "Saved secrets" } : {})}>
        {secrets.length === 0 ? (
          <div className="ade-secrets-empty">
            <span className="ade-modern-glyph" aria-hidden><Key size={16} weight="duotone" /></span>
            <div className="ade-ap-rowtitle">No secrets yet</div>
            <div className="ade-ap-rowhint">Add one below, or import a .env file.</div>
          </div>
        ) : (
          <>
            <div className="ade-secret-row ade-secret-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Value</span>
              <span role="columnheader">Saved to</span>
              <span role="columnheader" style={{ textAlign: "right" }}>Updated</span>
              <span role="columnheader" aria-label="Actions" />
            </div>
            {shownSecrets.length === 0 ? (
              <div className="ade-secrets-empty" role="row">
                <div className="ade-ap-rowhint" role="cell">No secret matches &ldquo;{search.trim()}&rdquo;.</div>
              </div>
            ) : null}
            {shownSecrets.map((secret) => {
              const isVisible = Boolean(visibleNames[secret.name]);
              const isBusy = busyName === secret.name;
              const isConfirmingDelete = confirmDeleteName === secret.name;
              const rowCopied = isCopied(secret.name);
              const revealed = revealedValues[secret.name];
              const showValue = isVisible && revealed != null;
              return (
                <div key={secret.name} className="ade-secret-row" role="row">
                  <span role="cell" className="ade-secret-name" title={secret.name}>{secret.name}</span>
                  <span role="cell" className="ade-secret-value" data-revealed={showValue ? "true" : undefined}>
                    {showValue ? revealed : (
                      <>
                        <span aria-hidden>{"•".repeat(Math.min(Math.max(secret.valueLength, 8), 12))}</span>
                        <span className="ade-secret-len">{secret.valueLength} characters</span>
                      </>
                    )}
                  </span>
                  <span role="cell">
                    <span
                      className="kit-tag"
                      title={secret.uploadPending ? "Saved here; not on your other machines until the upload finishes." : undefined}
                    >
                      {storageLabel(secret)}
                    </span>
                  </span>
                  <span role="cell" className="ade-secret-updated" title={formatUpdatedAt(secret.updatedAt)}>
                    {updatedLabel(secret.updatedAt)}
                  </span>
                  <span role="cell" className="ade-secret-actions">
                    <button
                      type="button"
                      className="ade-modern-btn"
                      data-variant="ghost"
                      data-icon="true"
                      title={isVisible ? "Hide value" : "Show value"}
                      aria-label={isVisible ? `Hide ${secret.name}` : `Reveal ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void toggleReveal(secret.name)}
                    >
                      {isVisible ? <EyeSlash size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      type="button"
                      className="ade-modern-btn"
                      data-variant="ghost"
                      data-icon="true"
                      data-copied={rowCopied ? "true" : undefined}
                      title={rowCopied ? "Copied" : "Copy value"}
                      aria-label={rowCopied ? `Copied ${secret.name}` : `Copy ${secret.name}`}
                      disabled={isBusy}
                      onClick={() => void copySecret(secret.name)}
                    >
                      {rowCopied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                    </button>
                    {isConfirmingDelete ? (
                      <button
                        type="button"
                        className="ade-modern-btn"
                        data-tone="danger"
                        aria-label={`Confirm delete ${secret.name}`}
                        disabled={isBusy}
                        onClick={() => void deleteSecret(secret.name)}
                      >
                        Delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ade-modern-btn ade-secret-delete"
                        data-variant="ghost"
                        data-icon="true"
                        title="Delete secret"
                        aria-label={`Delete ${secret.name}`}
                        disabled={isBusy}
                        onClick={() => void deleteSecret(secret.name)}
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </ModernSection>
  );

  const addForm = (
    <ModernSection
      group="Secrets"
      title="Add a secret"
      hint={storage === "account"
        ? "Follows your account to every machine that opens this repository."
        : "Stays on this computer only."}
    >
      <form onSubmit={handleSave} className="ade-secrets-add">
        <label className="ade-secrets-field">
          <span>Name</span>
          <input
            ref={nameInputRef}
            className="ade-modern-field"
            data-mono="true"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="STRIPE_API_KEY"
            aria-label="Secret name"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="ade-secrets-field">
          <span>Value</span>
          <input
            className="ade-modern-field"
            data-mono="true"
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
        <div className="ade-secrets-field">
          <span>Save to</span>
          <div role="radiogroup" aria-label="Secret storage" className="kit-seg" data-case="sentence">
            {([
              { value: "account", label: "Account" },
              { value: "device", label: "This device only" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={storage === option.value}
                onClick={() => setStorage(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <button type="submit" className="ade-modern-btn ade-secrets-submit" data-tone="primary" disabled={!canAdd}>
          <Plus size={12} weight="bold" />
          {saving ? "Saving…" : "Add secret"}
        </button>
      </form>
    </ModernSection>
  );

  const envFiles = (
    <ModernSection group="Secrets" title=".env files" hint="Move secrets in from, or out to, a plain .env file.">
      <ModernRows>
        <ModernRow
          title="Import"
          hint="Choose which keys to add from a .env file on this computer."
          control={(
            <button type="button" className="ade-modern-btn" aria-label="Import .env" disabled={choosingImport} onClick={() => void chooseEnvFile()}>
              <UploadSimple size={13} />
              {choosingImport ? "Opening…" : "Import…"}
            </button>
          )}
        />
        <ModernRow
          title="Export"
          hint={
            confirmingExport
              ? "Writes every value unencrypted to Downloads. Click again to confirm."
              : "Writes every value, unencrypted, to a .env file in Downloads."
          }
          control={(
            <button
              type="button"
              className="ade-modern-btn"
              data-tone={confirmingExport ? "danger" : undefined}
              aria-label={confirmingExport ? "Confirm plaintext export" : "Export .env"}
              disabled={exporting || secrets.length === 0}
              onClick={() => void exportSecrets()}
            >
              <DownloadSimple size={13} />
              {exporting ? "Exporting…" : confirmingExport ? "Confirm export" : "Export"}
            </button>
          )}
        />
      </ModernRows>
    </ModernSection>
  );

  return (
    <SettingsColumn wide>
      <div id={ANCHOR} data-settings-anchor={ANCHOR} className="ade-secrets-page" style={{ scrollMarginTop: 16 }}>
        {(message || error) && (
          <div
            role={error ? "alert" : "status"}
            className="ade-secrets-note"
            data-tone={error ? "crit" : noteTone === "warning" ? "warn" : "ok"}
          >
            {error
              ? <X size={14} weight="bold" />
              : noteTone === "warning" ? <WarningCircle size={14} weight="bold" /> : <Check size={14} weight="bold" />}
            <span>{error ?? message}</span>
          </div>
        )}
        {list}
        {addForm}
        {envFiles}
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
