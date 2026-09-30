import React, { useCallback, useMemo, useRef, useState } from "react";
import { DotsThree, PencilSimple, Plus } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";
import {
  HARNESS_PRESET_NAME_MAX_LENGTH,
  HarnessPresetImportError,
  exportHarnessPreset,
  importHarnessPreset,
  presetLabel,
  presetSourceLabel,
  type HarnessPreset,
  type HarnessPresetDraft,
  type HarnessPresetMissing,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, formatTimestamp, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { CustomToolMark } from "../../shared/CustomToolMark";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { RouteTestBadge } from "../../shared/ModelPicker/ReachableModelList";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { Z_LAYERS } from "../../ui/zLayers";
import { confirmDialog, promptDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { saveHarnessPresetsToAccount } from "../../../lib/harnessPresetAccountSync";
import { HelpHint } from "../primitives/HelpHint";
import { SettingsManagerPage } from "../primitives/SettingsManagerPage";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useApiCredentialsPin } from "../providers/keys/useApiCredentials";
import { bodyLogoFamily, PresetAgent, PresetModels } from "./presetFacts";
import { readStoredKeySources } from "./harnessSources";
import { CustomProviderDialog, emptyCustomProviderDraft } from "./CustomProviderDialog";
import { buildTerminalLauncher } from "./harnessLauncher";
import { starterSuggestions, type StarterSuggestion } from "./harnessReach";
import { routeTestKey, useHarnessReach, type HarnessReach, type HarnessRouteTestState } from "./useHarnessReach";
import { useHarnessPresets } from "./useHarnessPresets";

/**
 * Settings › Providers › Custom.
 *
 * One section, no drill-down: saved Custom providers lie flat as rows (mark,
 * name, the harness that runs it, the models it thinks with, then Test / Edit
 * / a ⋯ menu). An empty list is one line of help, a few one-click starters
 * built from what this computer has connected, and Add.
 *
 * "Custom" is the user-facing word for what the code calls a harness preset.
 * Import is a read, not a merge: the file opens as a prefilled dialog with its
 * gaps listed, so what lands in the list is something you looked at.
 */

const CUSTOM_HELP =
  "A custom provider runs any harness on any model you have connected — an OpenCode sign-in, a stored key, or a subscription through ADE's proxy. Pick one in any model picker.";

type DialogState =
  | { mode: "closed" }
  | { mode: "create"; draft: HarnessPresetDraft; missing: HarnessPresetMissing[] }
  | { mode: "edit"; presetId: string; draft: HarnessPresetDraft };

function draftOf(preset: HarnessPreset): HarnessPresetDraft {
  return {
    name: preset.name,
    harness: preset.harness,
    source: preset.source,
    model: preset.model,
    ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
    subagentModel: preset.subagentModel,
    ...(preset.subagentEffort ? { subagentEffort: preset.subagentEffort } : {}),
    agentOverrides: preset.agentOverrides,
    agentEfforts: preset.agentEfforts,
    accentColor: preset.accentColor,
    logo: preset.logo,
  };
}

export function CustomProvidersSection({
  status,
  storedProviders,
}: {
  /** The page's provider probe (harness availability in the dialog). Not re-fetched here. */
  status: AiSettingsStatus | null;
  /** Legacy stored-key provider list, for import's "do you hold this key" check. */
  storedProviders: readonly string[];
}) {
  const { pin } = useSettingsMachineScope();
  const credentialPin = useApiCredentialsPin();
  const { presets, createPreset, updatePreset, duplicatePreset, deletePreset } = useHarnessPresets();

  // Every list mutation now answers whether the ACCOUNT confirmed it. A row
  // action keeps its ordinary success toast either way (the change really did
  // happen on this computer) and adds this one when it did not reach the
  // account, so a preset a launch may not resolve is never silently trusted.
  const warnUnconfirmedAccountWrite = useCallback((error: string | null) => {
    if (!error) return;
    showToast({ tone: "warning", title: "Not on your ADE account yet", message: error });
  }, []);
  const reach = useHarnessReach({ enabled: true, pin });
  const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Credential rows are only needed to check an imported file against this
  // machine's keys, so they are read when a file is picked, not on mount.
  const loadCredentialSummaries = useCallback(async (): Promise<ApiCredentialSummary[]> => {
    const apiCredentials = window.ade?.apiCredentials;
    if (typeof apiCredentials?.list !== "function") return [];
    try {
      const rows = await apiCredentials.list({}, credentialPin);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }, [credentialPin]);

  const accountLabel = useCallback(
    (instanceId: string) => reach.accounts.find((entry) => entry.instanceId === instanceId)?.label ?? null,
    [reach.accounts],
  );

  const starters = useMemo(() => (presets.length === 0 ? starterSuggestions(reach) : []), [presets.length, reach]);

  const openCreate = useCallback(() => {
    setDialog({ mode: "create", draft: emptyCustomProviderDraft(), missing: [] });
  }, []);

  const createFromStarter = useCallback((starter: StarterSuggestion) => {
    void createPreset({
      ...emptyCustomProviderDraft(starter.harness),
      name: starter.name,
      source: starter.group.source,
      model: starter.model.id,
    }).then(({ preset, accountError }) => {
      if (preset) showToast({ tone: "success", title: `Created ${presetLabel(preset)}`, message: "Pick it from any model picker." });
      warnUnconfirmedAccountWrite(accountError);
    });
  }, [createPreset, warnUnconfirmedAccountWrite]);

  const handleExport = useCallback((preset: HarnessPreset) => {
    try {
      const payload = JSON.stringify(exportHarnessPreset(preset), null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${preset.name.trim().replace(/[^\w.-]+/g, "-").toLowerCase() || "custom"}.ade-harness.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast({
        tone: "success",
        title: `Exported ${presetLabel(preset)}`,
        message: "The file names your account or key. It never carries the key itself.",
      });
    } catch {
      showToast({ tone: "error", title: "That one could not be written to a file" });
    }
  }, []);

  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const [text, credentialSummaries] = await Promise.all([file.text(), loadCredentialSummaries()]);
      const keySources = readStoredKeySources(status, storedProviders, credentialSummaries);
      const catalogSources = reach.catalog?.sources ?? [];
      const result = importHarnessPreset(text, {
        accountInstanceIds: reach.accounts.map((entry) => entry.instanceId),
        credentialIds: [
          ...keySources.map((entry) => entry.credentialId),
          ...catalogSources.flatMap((entry) => (entry.source.kind === "key" ? [entry.source.credentialId] : [])),
        ],
        proxySignInAvailable: reach.proxyAvailable,
        openCodeProviderIds: catalogSources.flatMap((entry) =>
          entry.source.kind === "opencode" ? [entry.source.providerId] : [],
        ),
      });
      setDialog({ mode: "create", draft: result.preset, missing: result.missing });
    } catch (importError) {
      showToast({
        tone: "error",
        title: importError instanceof HarnessPresetImportError ? importError.message : "That file could not be read.",
      });
    }
  }, [loadCredentialSummaries, reach.accounts, reach.catalog, reach.proxyAvailable, status, storedProviders]);

  const handleRename = useCallback(async (preset: HarnessPreset) => {
    const name = await promptDialog({
      title: "Rename custom provider",
      defaultValue: preset.name,
      confirmLabel: "Rename",
      validate: (value) =>
        value.trim().length > HARNESS_PRESET_NAME_MAX_LENGTH
          ? `Names are at most ${HARNESS_PRESET_NAME_MAX_LENGTH} characters.`
          : null,
    });
    if (name === null || !name.trim()) return;
    const { preset: saved, accountError } = await updatePreset(preset.id, { ...draftOf(preset), name: name.trim() });
    if (saved) showToast({ tone: "success", title: `Renamed to ${presetLabel(saved)}` });
    warnUnconfirmedAccountWrite(accountError);
  }, [updatePreset, warnUnconfirmedAccountWrite]);

  const handleDelete = useCallback(async (preset: HarnessPreset) => {
    const confirmed = await confirmDialog({
      title: `Delete ${presetLabel(preset)}?`,
      message: "Chats that already run on it keep running. New chats can no longer pick it.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    const { accountError } = await deletePreset(preset.id);
    showToast({ tone: "success", title: `Deleted ${presetLabel(preset)}` });
    warnUnconfirmedAccountWrite(accountError);
  }, [deletePreset, warnUnconfirmedAccountWrite]);

  const handleCopyLauncher = useCallback((preset: HarnessPreset) => {
    const line = buildTerminalLauncher({
      presetId: preset.id,
      harness: preset.harness,
      model: preset.model,
      source: preset.source,
      ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
    });
    if (!line) return;
    void copyTextToClipboard(line).then((ok) =>
      showToast(ok
        ? { tone: "success", title: "Launcher copied", message: "Paste it in any terminal. It holds no key." }
        : { tone: "error", title: "Could not copy the launcher" }),
    );
  }, []);

  const toolbar = (
    <>
      <button type="button" style={outlineButton()} onClick={() => importInputRef.current?.click()}>
        Import
      </button>
      <button type="button" style={primaryButton()} onClick={openCreate} data-custom-add="">
        <Plus size={12} weight="bold" /> Add
      </button>
    </>
  );

  return (
    <SettingsManagerPage
      anchor="ai-harnesses"
      title="Custom"
      leading={<CustomToolMark size={18} />}
      titleAdornment={<HelpHint text={CUSTOM_HELP} />}
      toolbar={toolbar}
    >
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        aria-label="Import a custom provider"
        style={{ display: "none" }}
        onChange={(event) => {
          void handleImportFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {presets.length === 0 ? (
        <div data-custom-empty="" style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: SANS_FONT }}>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: COLORS.textMuted }}>
            Run any harness on a model you already pay for. Save the pairing once and pick it from any model picker.
          </p>
          {starters.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {starters.map((starter) => (
                <button
                  key={starter.key}
                  type="button"
                  data-custom-starter={starter.key}
                  onClick={() => createFromStarter(starter)}
                  title={`${starter.group.label} · ${starter.group.detail}`}
                  style={starterStyle}
                >
                  <ProviderLogo family={bodyLogoFamily(starter.harness)} size={14} />
                  <span style={{ fontWeight: 600 }}>{starter.name}</span>
                  <span style={{ color: COLORS.textMuted }}>· {starter.group.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div data-custom-preset-list="" style={{ display: "flex", flexDirection: "column" }}>
          {presets.map((preset, index) => (
            <CustomProviderRow
              key={preset.id}
              preset={preset}
              first={index === 0}
              reach={reach}
              accountLabel={accountLabel}
              onEdit={() => setDialog({ mode: "edit", presetId: preset.id, draft: draftOf(preset) })}
              onRename={() => void handleRename(preset)}
              onDuplicate={() => {
                void duplicatePreset(preset.id).then(({ preset: copy, accountError }) => {
                  if (copy) showToast({ tone: "success", title: `Duplicated as ${presetLabel(copy)}` });
                  warnUnconfirmedAccountWrite(accountError);
                });
              }}
              onExport={() => handleExport(preset)}
              onCopyLauncher={() => handleCopyLauncher(preset)}
              onDelete={() => void handleDelete(preset)}
            />
          ))}
        </div>
      )}

      {dialog.mode !== "closed" ? (
        <CustomProviderDialog
          open
          initialDraft={dialog.draft}
          editingPresetId={dialog.mode === "edit" ? dialog.presetId : null}
          missing={dialog.mode === "create" ? dialog.missing : []}
          status={status}
          reach={reach}
          onClose={() => setDialog({ mode: "closed" })}
          onSave={async (draft) => {
            const { preset: saved, accountError } = dialog.mode === "edit"
              ? await updatePreset(dialog.presetId, draft)
              : await createPreset(draft);
            if (!accountError) {
              if (saved) {
                showToast({
                  tone: "success",
                  title: `${dialog.mode === "edit" ? "Saved" : "Created"} ${presetLabel(saved)}`,
                  message: "Pick it from any model picker.",
                });
              }
              setDialog({ mode: "closed" });
              return null;
            }
            // The account has not confirmed the write. Keep the dialog open so
            // the reason sits next to the thing it is about, and so Retry is
            // one click away; the preset itself is already saved here.
            return accountError;
          }}
          onRetryAccountSync={async () => (await saveHarnessPresetsToAccount()).message}
        />
      ) : null}
    </SettingsManagerPage>
  );
}

function CustomProviderRow({
  preset,
  first,
  reach,
  accountLabel,
  onEdit,
  onRename,
  onDuplicate,
  onExport,
  onCopyLauncher,
  onDelete,
}: {
  preset: HarnessPreset;
  first: boolean;
  reach: HarnessReach;
  accountLabel: (instanceId: string) => string | null;
  onEdit: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onCopyLauncher: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const name = presetLabel(preset);
  const source = preset.source;
  // A live check exists for OpenCode sign-ins and stored keys; an account or a
  // subscription is checked by signing it in.
  const testable = source.kind === "key" || source.kind === "opencode";
  const testState: HarnessRouteTestState | undefined = testable
    ? reach.testState[routeTestKey(preset.harness, source, preset.model)]
    : undefined;
  const hasLauncher = buildTerminalLauncher({ presetId: preset.id, harness: preset.harness, model: preset.model, source: preset.source }) != null;

  const item = (label: string, onClick: () => void, danger = false) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        border: "none",
        background: "transparent",
        fontSize: 11.5,
        fontFamily: SANS_FONT,
        color: danger ? COLORS.danger : COLORS.textSecondary,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      data-custom-preset-row={preset.id}
      style={{
        display: "grid",
        // Small minimums: at 150% zoom the pane is ~700px, and a row that
        // cannot shrink is what makes the page scroll sideways.
        gridTemplateColumns: "minmax(120px, 1.1fr) minmax(86px, 0.7fr) minmax(150px, 1.3fr) auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 2px",
        borderTop: first ? "none" : `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textPrimary,
        minWidth: 0,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <HarnessLogo logo={preset.logo} size={22} accentColor={preset.accentColor} />
        <span style={{ minWidth: 0 }}>
          <span
            style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}
            title={`Updated ${formatTimestamp(preset.updatedAt)}`}
          >
            {name}
          </span>
          <span
            style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: COLORS.textMuted }}
          >
            {presetSourceLabel(preset.source, accountLabel)}
          </span>
        </span>
      </span>

      <PresetAgent harness={preset.harness} />

      <PresetModels preset={preset} />

      <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <RouteTestBadge state={testState} />
        {testable ? (
          <button
            type="button"
            aria-label={`Test ${name}`}
            disabled={testState?.status === "testing"}
            onClick={() => void reach.testRoute(preset.harness, source, preset.model)}
            style={outlineButton({ padding: "0 8px" })}
          >
            Test
          </button>
        ) : null}
        <button type="button" aria-label={`Edit ${name}`} title="Edit" onClick={onEdit} style={outlineButton({ padding: "0 7px" })}>
          <PencilSimple size={13} weight="bold" />
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          aria-label={`More actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((openNow) => !openNow)}
          style={outlineButton({ padding: "0 6px" })}
        >
          <DotsThree size={14} weight="bold" />
        </button>
        <AnchoredMenu
          open={menuOpen}
          anchorRef={menuButtonRef}
          onClose={() => setMenuOpen(false)}
          placement="bottom-end"
          zIndex={Z_LAYERS.popover}
          role="menu"
          aria-label={`${name} actions`}
          style={{
            minWidth: 170,
            padding: "4px 0",
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
          }}
        >
          {item("Rename", onRename)}
          {item("Duplicate", onDuplicate)}
          {hasLauncher ? item("Copy terminal launcher", onCopyLauncher) : null}
          {item("Export", onExport)}
          {item("Delete", onDelete, true)}
        </AnchoredMenu>
      </span>
    </div>
  );
}

const starterStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  height: 30,
  padding: "0 12px",
  borderRadius: 8,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: "var(--color-card)",
  fontFamily: SANS_FONT,
  fontSize: 11.5,
  color: COLORS.textPrimary,
  cursor: "pointer",
};
