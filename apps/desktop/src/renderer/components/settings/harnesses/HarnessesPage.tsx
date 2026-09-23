import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, DownloadSimple, PencilSimple, TextAa, Trash } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";
import {
  HARNESS_PRESET_NAME_MAX_LENGTH,
  HarnessPresetImportError,
  exportHarnessPreset,
  importHarnessPreset,
  presetLabel,
  presetSourceLabel,
  presetSummary,
  type HarnessPreset,
  type HarnessPresetDraft,
  type HarnessPresetMissing,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, formatTimestamp, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { CustomToolMark } from "../../shared/CustomToolMark";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { HelpHint } from "../primitives/HelpHint";
import {
  SettingsManagerEmpty,
  SettingsManagerPage,
} from "../primitives/SettingsManagerPage";
import { PresetAgent, PresetModels } from "./presetFacts";
import { loadHarnessAccounts, proxySignInAvailable, readStoredKeySources, type HarnessAccountSource } from "./harnessSources";
import { HarnessWizard, emptyHarnessDraft } from "./HarnessWizard";
import { useHarnessPresets } from "./useHarnessPresets";

/**
 * Settings → Providers → Custom.
 *
 * "Custom" is the user-facing name for what the code still calls a harness
 * preset: a harness and the model source it runs on, saved together. The ids and
 * types keep the old word because they are storage, not copy.
 *
 * The rows lie flat on the page rather than inside a bordered table. A manager
 * page is already a card; a second box drawn inside it, with its own header
 * strip and its own hairlines, read as a spreadsheet embedded in a settings
 * page. Each row now says the same things in reading order — mark, name, the
 * harness that runs it, the models it thinks with — with the actions at the end.
 *
 * Import is deliberately a read, not a merge: the file becomes a prefilled
 * wizard with its gaps listed, so what lands in your list is something you
 * looked at, not whatever the file claimed.
 */

/** The one sentence behind the "?" beside the title. */
const CUSTOM_HELP = "A custom provider combines a harness and a model into one setup you can pick from any model picker.";

/**
 * One icon per row action, named for the screen reader and the tooltip.
 *
 * Four worded buttons per row pushed the table past its column and hid
 * "Delete" behind a sideways scroll on a 150% display; icons keep every action
 * in view without shrinking the harness and source columns that carry meaning.
 */
function RowIconButton({
  label,
  rowName,
  onClick,
  children,
}: {
  label: string;
  /**
   * The preset this button acts on. Four icon buttons per row across a list of
   * presets announced as "Edit, Duplicate, Export, Delete" over and over says
   * nothing about WHICH one — the tooltip stays short, the accessible name
   * carries the row.
   */
  rowName?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={rowName ? `${label} ${rowName}` : label}
      title={label}
      onClick={onClick}
      style={outlineButton({ padding: "0 7px" })}
    >
      {children}
    </button>
  );
}

type WizardState =
  | { mode: "closed" }
  | { mode: "create"; draft: HarnessPresetDraft; missing: HarnessPresetMissing[] }
  | { mode: "edit"; presetId: string; draft: HarnessPresetDraft };

export function HarnessesPage({ onBack }: { onBack?: () => void }) {
  const { presets, createPreset, updatePreset, duplicatePreset, deletePreset } = useHarnessPresets();
  const [wizard, setWizard] = useState<WizardState>({ mode: "closed" });
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [credentialSummaries, setCredentialSummaries] = useState<ApiCredentialSummary[]>([]);
  const [accounts, setAccounts] = useState<HarnessAccountSource[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Rename is its own action rather than "open the three-step wizard and change
  // one field" — renaming a saved thing is the cheapest edit there is, and
  // making it the most expensive one is why lists fill with "Harness 2".
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const apiCredentials = window.ade?.apiCredentials;
        const credentialRows = typeof apiCredentials?.list === "function"
          ? apiCredentials.list().catch(() => [] as ApiCredentialSummary[])
          : Promise.resolve([] as ApiCredentialSummary[]);
        const [next, keys, credentials, accountRows] = await Promise.all([
          window.ade?.ai?.getStatus?.() ?? Promise.resolve(null),
          window.ade?.ai?.listApiKeys?.() ?? Promise.resolve([] as string[]),
          credentialRows,
          loadHarnessAccounts(),
        ]);
        if (cancelled) return;
        setStatus(next ?? null);
        setStoredProviders(Array.isArray(keys) ? keys : []);
        setCredentialSummaries(Array.isArray(credentials) ? credentials : []);
        setAccounts(accountRows);
      } catch {
        // A provider probe that fails leaves the table fully usable: presets are
        // stored settings, not live provider state. Only the wizard's
        // availability notes go quiet.
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const accountLabel = useCallback(
    (instanceId: string) => accounts.find((entry) => entry.instanceId === instanceId)?.label ?? null,
    [accounts],
  );

  const handleExport = useCallback((preset: HarnessPreset) => {
    try {
      const payload = JSON.stringify(exportHarnessPreset(preset), null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${preset.name.trim().replace(/[^\w.-]+/g, "-").toLowerCase() || "harness"}.ade-harness.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setError(null);
      setNotice(`Exported ${presetLabel(preset)}. The file names your account or key; it never carries the key itself.`);
    } catch {
      setNotice(null);
      setError("That one could not be written to a file.");
    }
  }, []);

  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setNotice(null);
    setError(null);
    try {
      const text = await file.text();
      const result = importHarnessPreset(text, {
        accountInstanceIds: accounts.map((entry) => entry.instanceId),
        credentialIds: readStoredKeySources(status, storedProviders, credentialSummaries).map((entry) => entry.credentialId),
        proxySignInAvailable: proxySignInAvailable(),
      });
      setWizard({ mode: "create", draft: result.preset, missing: result.missing });
    } catch (importError) {
      setError(
        importError instanceof HarnessPresetImportError
          ? importError.message
          : "That file could not be read.",
      );
    }
  }, [accounts, credentialSummaries, status, storedProviders]);

  // Two buttons, and only two. Back is not one of them: it is navigation, not
  // an action on this list, so it sits before the title as an arrow instead of
  // competing with Add new for the eye.
  const toolbar = (
    <>
      <button type="button" style={outlineButton()} onClick={() => importInputRef.current?.click()}>
        Import
      </button>
      <button
        type="button"
        style={primaryButton()}
        onClick={() => setWizard({ mode: "create", draft: emptyHarnessDraft(), missing: [] })}
      >
        Add new
      </button>
    </>
  );

  const rows = useMemo(() => presets, [presets]);

  if (wizard.mode !== "closed") {
    return (
      <div id="ai-harnesses" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <HarnessWizard
          initialDraft={wizard.draft}
          editingPresetId={wizard.mode === "edit" ? wizard.presetId : null}
          missing={wizard.mode === "create" ? wizard.missing : []}
          status={status}
          storedProviders={storedProviders}
          credentialSummaries={credentialSummaries}
          onCancel={() => setWizard({ mode: "closed" })}
          onSave={(draft) => {
            if (wizard.mode === "edit") {
              const saved = updatePreset(wizard.presetId, draft);
              setNotice(saved ? `Saved ${presetLabel(saved)}.` : null);
            } else {
              const saved = createPreset(draft);
              setNotice(saved ? `Created ${presetLabel(saved)}.` : null);
            }
            setWizard({ mode: "closed" });
          }}
        />
      </div>
    );
  }

  return (
    <SettingsManagerPage
      anchor="ai-harnesses"
      title="Custom"
      leading={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {onBack ? (
            <button
              type="button"
              aria-label="Back to providers"
              title="Back to providers"
              onClick={onBack}
              style={outlineButton({ padding: "0 6px" })}
            >
              <ArrowLeft size={13} weight="bold" />
            </button>
          ) : null}
          <CustomToolMark size={18} />
        </span>
      }
      titleAdornment={<HelpHint text={CUSTOM_HELP} />}
      toolbar={toolbar}
    >
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        aria-label="Import a custom setup"
        style={{ display: "none" }}
        onChange={(event) => {
          void handleImportFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {notice ? <Banner tone="success" message={notice} onDismiss={() => setNotice(null)} /> : null}
      {error ? <Banner tone="error" message={error} onDismiss={() => setError(null)} /> : null}

      {rows.length === 0 ? (
        <SettingsManagerEmpty
          title="Nothing custom yet"
          description="A custom provider combines a harness and a model into one setup you can pick from any model picker."
          action={
            <button
              type="button"
              style={primaryButton()}
              onClick={() => setWizard({ mode: "create", draft: emptyHarnessDraft(), missing: [] })}
            >
              Add new
            </button>
          }
        />
      ) : (
        <div data-custom-preset-list="" style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((preset, index) => (
            <div
              key={preset.id}
              data-custom-preset-row={preset.id}
              style={{
                display: "grid",
                // Small minimums on purpose. At 150% zoom the settings pane is
                // about 700 CSS px wide, and a row whose tracks cannot shrink
                // is the element that decides whether the page scrolls
                // sideways. Every cell ellipsizes instead.
                gridTemplateColumns: "minmax(110px, 1.1fr) minmax(86px, 0.7fr) minmax(150px, 1.3fr) auto",
                gap: 12,
                alignItems: "center",
                padding: "11px 2px",
                borderTop: index === 0 ? "none" : `1px solid ${COLORS.borderMuted}`,
                fontFamily: SANS_FONT,
                fontSize: 12,
                color: COLORS.textPrimary,
                minWidth: 0,
              }}
            >
              {/* 1 — the preset's own mark and name. */}
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <HarnessLogo logo={preset.logo} size={22} accentColor={preset.accentColor} />
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: 600,
                  }}
                  title={`${presetSourceLabel(preset.source, accountLabel)} · updated ${formatTimestamp(preset.updatedAt)}`}
                >
                  {presetLabel(preset)}
                </span>
              </span>

              {/* 2 — the harness that runs it, with its brand mark. */}
              <PresetAgent harness={preset.harness} />

              {/* 3 — what it thinks with, labelled by role. */}
              <PresetModels preset={preset} />

              {/* 4 — the four things a saved row needs. */}
              <span style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                {confirmDeleteId === preset.id ? (
                  <>
                    <span style={{ fontSize: 11, color: COLORS.textMuted, alignSelf: "center" }}>Delete?</span>
                    <button
                      type="button"
                      style={outlineButton({ color: COLORS.danger, border: `1px solid ${COLORS.danger}` })}
                      onClick={() => {
                        deletePreset(preset.id);
                        setConfirmDeleteId(null);
                        setNotice(`Deleted ${presetLabel(preset)}.`);
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" style={outlineButton()} onClick={() => setConfirmDeleteId(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <RowIconButton
                      label="Edit"
                      rowName={presetLabel(preset)}
                      onClick={() =>
                        setWizard({
                          mode: "edit",
                          presetId: preset.id,
                          draft: {
                            name: preset.name,
                            harness: preset.harness,
                            source: preset.source,
                            model: preset.model,
                            ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
                            subagentModel: preset.subagentModel,
                            agentOverrides: preset.agentOverrides,
                            accentColor: preset.accentColor,
                            logo: preset.logo,
                          },
                        })
                      }
                    >
                      <PencilSimple size={13} weight="bold" />
                    </RowIconButton>
                    <RowIconButton
                      label="Rename"
                      rowName={presetLabel(preset)}
                      onClick={() => setRenaming({ id: preset.id, name: preset.name })}
                    >
                      <TextAa size={13} weight="bold" />
                    </RowIconButton>
                    <RowIconButton
                      label="Duplicate"
                      rowName={presetLabel(preset)}
                      onClick={() => {
                        const copy = duplicatePreset(preset.id);
                        if (copy) setNotice(`Duplicated as ${presetLabel(copy)}.`);
                      }}
                    >
                      <Copy size={13} weight="bold" />
                    </RowIconButton>
                    <RowIconButton label="Export" rowName={presetLabel(preset)} onClick={() => handleExport(preset)}>
                      <DownloadSimple size={13} weight="bold" />
                    </RowIconButton>
                    <RowIconButton
                      label="Delete"
                      rowName={presetLabel(preset)}
                      onClick={() => setConfirmDeleteId(preset.id)}
                    >
                      <Trash size={13} weight="bold" />
                    </RowIconButton>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {renaming ? (
        <RenameDialog
          name={renaming.name}
          onCancel={() => setRenaming(null)}
          onSave={(name) => {
            const preset = presets.find((entry) => entry.id === renaming.id);
            if (preset) {
              const saved = updatePreset(preset.id, {
                name,
                harness: preset.harness,
                source: preset.source,
                model: preset.model,
                ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
                subagentModel: preset.subagentModel,
                agentOverrides: preset.agentOverrides,
                accentColor: preset.accentColor,
                logo: preset.logo,
              });
              setNotice(saved ? `Renamed to ${presetLabel(saved)}.` : null);
            }
            setRenaming(null);
          }}
        />
      ) : null}
    </SettingsManagerPage>
  );
}

/**
 * Rename, in place.
 *
 * One field and two buttons. It writes through `updatePreset` like every other
 * edit, so a rename is the same kind of change as any other and the list does
 * not need a second code path to notice it.
 */
function RenameDialog({
  name,
  onCancel,
  onSave,
}: {
  name: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  return (
    <form
      data-custom-rename=""
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave(trimmed.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH));
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderRadius: 8,
        border: `1px solid ${COLORS.outlineBorder}`,
        background: "var(--color-card)",
        fontFamily: SANS_FONT,
      }}
    >
      <label htmlFor="custom-rename-input" style={{ fontSize: 11.5, color: COLORS.textMuted }}>
        Name
      </label>
      <input
        id="custom-rename-input"
        autoFocus
        value={value}
        maxLength={HARNESS_PRESET_NAME_MAX_LENGTH}
        onChange={(event) => setValue(event.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          height: 28,
          padding: "0 8px",
          borderRadius: 6,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: COLORS.recessedBg,
          color: COLORS.textPrimary,
          fontFamily: SANS_FONT,
          fontSize: 12,
        }}
      />
      <button type="submit" style={primaryButton()} disabled={!trimmed}>Save</button>
      <button type="button" style={outlineButton()} onClick={onCancel}>Cancel</button>
    </form>
  );
}

function Banner({
  tone,
  message,
  onDismiss,
}: {
  tone: "success" | "error";
  message: string;
  onDismiss: () => void;
}) {
  const color = tone === "error" ? COLORS.danger : COLORS.success;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "9px 12px",
        borderRadius: 8,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        fontFamily: SANS_FONT,
        fontSize: 11.5,
        color: COLORS.textPrimary,
      }}
    >
      <span style={{ minWidth: 0 }}>{message}</span>
      <button type="button" style={outlineButton()} onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
