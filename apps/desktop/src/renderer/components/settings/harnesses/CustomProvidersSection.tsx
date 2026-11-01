import React, { useCallback, useMemo, useRef, useState } from "react";
import { ArrowRight, DotsThree, PencilSimple, Plus } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_NAME_MAX_LENGTH,
  HarnessPresetImportError,
  exportHarnessPreset,
  importHarnessPreset,
  presetLabel,
  presetSourceLogo,
  presetSourceSummary,
  type HarnessPreset,
  type HarnessPresetDraft,
  type HarnessPresetMissing,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, formatTimestamp } from "../../lanes/laneDesignTokens";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { RouteTestBadge } from "../../shared/ModelPicker/ReachableModelList";
import { ModelRowLogo, ProviderLogo } from "../../shared/ProviderLogos";
import { providerColor } from "../../usage/providerColors";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { Z_LAYERS } from "../../ui/zLayers";
import { confirmDialog, promptDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { saveHarnessPresetsToAccount } from "../../../lib/harnessPresetAccountSync";
import { HelpHint } from "../primitives/HelpHint";
import { ModernSection } from "../primitives/SettingsModern";
import "./customProviders.css";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useApiCredentialsPin } from "../providers/keys/useApiCredentials";
import { bodyLogoFamily } from "./presetFacts";
import { CustomHero, CustomEquation } from "./CustomProviderHero";
import { harnessModelFamily, harnessModelLabel, providerFamilyForSource } from "./harnessModels";
import { readStoredKeySources } from "./harnessSources";
import { CustomProviderDialog, emptyCustomProviderDraft } from "./CustomProviderDialog";
import { buildTerminalLauncher } from "./harnessLauncher";
import { harnessShortLabel, sourceSummary, starterSuggestions, type StarterSuggestion } from "./harnessReach";
import { routeTestKey, useHarnessReach, type HarnessReach, type HarnessRouteTestState } from "./useHarnessReach";
import { useHarnessPresets } from "./useHarnessPresets";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { modelMentionEffortLabel } from "../../../../shared/modelMentions";

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
  "A custom provider runs any harness on any model you have connected: another provider's sign-in (no extra login), an OpenCode sign-in, or a stored API key. Pick one in any model picker.";

/** The section's own colour: a custom provider's default accent, so the hero reads as "yours", not a vendor's. */
const CUSTOM_BANNER_COLOR = DEFAULT_HARNESS_PRESET_ACCENT;

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
  const { pin, machineName } = useSettingsMachineScope();
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
    if (!isAdeAvailable(apiCredentials?.list)) return [];
    try {
      const rows = await apiCredentials.list({}, credentialPin);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }, [credentialPin]);

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
        proxyAvailable: reach.proxyAvailable,
        subscriptionProviders: [
          ...reach.accounts.filter((entry) => entry.signedIn && !entry.loginBroken).map((entry) => entry.provider),
          ...catalogSources.flatMap((entry) => (entry.source.kind === "subscription" ? [entry.source.provider] : [])),
        ],
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
      <HelpHint text={CUSTOM_HELP} />
      <button type="button" className="ade-modern-btn" onClick={() => importInputRef.current?.click()}>
        Import
      </button>
      <button type="button" className="ade-modern-btn" data-tone="primary" onClick={openCreate} data-custom-add="">
        <Plus size={12} weight="bold" /> Add
      </button>
    </>
  );

  return (
    <ModernSection
      group="Connections"
      anchor="ai-harnesses"
      title="Custom"
      hint="Any harness on a model you already pay for — saved to your account, on every computer."
      actions={toolbar}
    >
      {pin ? (
        // The rest of this page edits the selected machine; this list does
        // not, and reading it as that machine's list is how a preset saved on
        // one computer was expected on another before it had synced there.
        <p data-custom-account-scope="" className="ade-custom-empty-copy" style={{ margin: "0 0 10px" }}>
          Saved to your account — reaches {machineName} when it syncs.
        </p>
      ) : null}
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
        <div data-custom-empty="" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <CustomHero color={CUSTOM_BANNER_COLOR} label="Custom providers">
            <CustomEquation />
            <div className="ade-cp-hero-id">
              <span className="ade-cp-hero-title">Any harness. Any model you pay for.</span>
              <span className="ade-cp-hero-copy">
                Run Claude Code on your ChatGPT plan, or Codex on your Claude plan. ADE uses the sign-ins you
                already have, so there is nothing new to log in to.
              </span>
              <div className="ade-cp-hero-actions">
                <button type="button" className="ade-cp-hero-btn" data-primary="true" onClick={openCreate}>
                  <Plus size={12} weight="bold" /> Create one
                </button>
                <button type="button" className="ade-cp-hero-btn" onClick={() => importInputRef.current?.click()}>
                  Import a file
                </button>
              </div>
            </div>
          </CustomHero>
          {starters.length > 0 ? (
            <>
              <div className="ade-cp-eyebrow-row">
                <span className="kit-eyebrow">Or start from what you have</span>
              </div>
              <div className="ade-cp-grid">
                {starters.map((starter) => (
                  <StarterCard key={starter.key} starter={starter} onCreate={() => createFromStarter(starter)} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div data-custom-preset-list="" className="ade-cp-grid">
          {presets.map((preset) => (
            <CustomProviderRow
              key={preset.id}
              preset={preset}
              reach={reach}
              sourceText={presetSourceText(preset, reach)}
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
          <button type="button" className="ade-pv-open ade-cp-card" data-new="true" onClick={openCreate} style={{ "--cp-accent": CUSTOM_BANNER_COLOR } as React.CSSProperties}>
            <Plus size={16} />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>New custom provider</span>
          </button>
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
    </ModernSection>
  );
}

/** "ChatGPT Plus · you@example.com", "Grok sign-in", "API key · Work". */
function presetSourceText(preset: HarnessPreset, reach: HarnessReach): string {
  const source = preset.source;
  const account = source.kind === "account"
    ? reach.accounts.find((entry) => entry.instanceId === source.instanceId)
    : null;
  const { title, detail } = presetSourceSummary(source, account);
  return detail ? `${title} · ${detail}` : title;
}

/** Harness + model, as two chips: what this custom provider is made of. */
function PairChips({ harness, modelId, modelLabel, family }: {
  harness: HarnessPreset["harness"];
  modelId: string;
  modelLabel: string;
  family: ReturnType<typeof harnessModelFamily>;
}) {
  return (
    <div className="ade-cp-pair">
      <span className="ade-cp-pair-chip" data-preset-agent={harness}>
        <ProviderLogo family={bodyLogoFamily(harness)} size={13} />
        <span>{harnessShortLabel(harness)}</span>
      </span>
      <span className="ade-cp-pair-op">+</span>
      <span className="ade-cp-pair-chip" data-preset-model="main" style={{ flex: "0 1 auto" }}>
        {family ? <ModelRowLogo modelFamily={family} modelId={modelId} size={13} /> : null}
        <span>{modelLabel}</span>
      </span>
    </div>
  );
}

/** One click to create a combo this computer can already run. */
function StarterCard({ starter, onCreate }: { starter: StarterSuggestion; onCreate: () => void }) {
  const summary = sourceSummary(starter.group);
  return (
    <button
      type="button"
      className="ade-pv-open ade-cp-card"
      data-starter="true"
      data-custom-starter={starter.key}
      onClick={onCreate}
      title={`Create ${starter.name}`}
      style={{ "--cp-accent": providerColor(starter.harness) } as React.CSSProperties}
    >
      <span className="ade-cp-card-top">
        <span className="ade-cp-card-logo"><ProviderLogo family={bodyLogoFamily(starter.harness)} size={18} /></span>
        <span className="ade-cp-card-id">
          <span className="ade-cp-card-name">{starter.name}</span>
          <span className="ade-cp-card-meta">{summary.detail ? `${summary.title} · ${summary.detail}` : summary.title}</span>
        </span>
      </span>
      <PairChips
        harness={starter.harness}
        modelId={starter.model.id}
        modelLabel={starter.model.label}
        family={starter.model.family ?? null}
      />
      <span className="ade-cp-card-foot">
        <span className="ade-cp-card-source">
          {starter.model.route.kind === "proxy" && starter.group.kind === "subscription" ? "No extra login" : starter.group.detail}
        </span>
        <span className="ade-cp-card-cta">Create <ArrowRight size={11} weight="bold" /></span>
      </span>
    </button>
  );
}

function CustomProviderRow({
  preset,
  reach,
  sourceText,
  onEdit,
  onRename,
  onDuplicate,
  onExport,
  onCopyLauncher,
  onDelete,
}: {
  preset: HarnessPreset;
  reach: HarnessReach;
  sourceText: string;
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
  const family = harnessModelFamily(preset.model) ?? providerFamilyForSource(preset.source);
  const subagents = preset.subagentModel !== "inherit" ? harnessModelLabel(preset.subagentModel) : null;
  // Only what differs from the defaults: a quiet card says "nothing special".
  const meta = [
    preset.reasoningEffort ? `${modelMentionEffortLabel(preset.reasoningEffort)} effort` : null,
    subagents ? `subagents on ${subagents}` : null,
  ].filter(Boolean).join(" · ");

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
      className="ade-pv-open ade-cp-card"
      style={{ "--cp-accent": preset.accentColor } as React.CSSProperties}
    >
      <div className="ade-cp-card-top">
        <span className="ade-cp-card-logo"><HarnessLogo logo={preset.logo} size={20} /></span>
        <span className="ade-cp-card-id">
          <span className="ade-cp-card-name" title={`Updated ${formatTimestamp(preset.updatedAt)}`}>{name}</span>
          {meta ? <span className="ade-cp-card-meta">{meta}</span> : null}
        </span>
        <span className="ade-cp-card-actions">
          <button type="button" aria-label={`Edit ${name}`} title="Edit" onClick={onEdit} className="ade-modern-btn" data-variant="ghost" data-icon="true">
            <PencilSimple size={13} weight="bold" />
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={`More actions for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((openNow) => !openNow)}
            className="ade-modern-btn"
            data-variant="ghost"
            data-icon="true"
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
      <PairChips harness={preset.harness} modelId={preset.model} modelLabel={harnessModelLabel(preset.model)} family={family} />
      <div className="ade-cp-card-foot">
        <ProviderLogo family={presetSourceLogo(source)} size={12} />
        <span className="ade-cp-card-source" title={sourceText}>{sourceText}</span>
        <RouteTestBadge state={testState} />
        {testable ? (
          <button
            type="button"
            aria-label={`Test ${name}`}
            disabled={testState?.status === "testing"}
            onClick={() => void reach.testRoute(preset.harness, source, preset.model)}
            className="ade-modern-btn"
            data-size="sm"
          >
            Test
          </button>
        ) : null}
      </div>
    </div>
  );
}
