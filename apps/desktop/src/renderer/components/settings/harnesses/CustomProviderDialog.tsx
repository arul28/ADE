import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, Terminal, UploadSimple } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_NAME_MAX_LENGTH,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  harnessBodyLabel,
  harnessPresetAgentOverrideNote,
  harnessPresetMissingCopy,
  presetSourceLabel,
  validateHarnessPreset,
  type HarnessPresetBody,
  type HarnessPresetDraft,
  type HarnessPresetLogo,
  type HarnessPresetMissing,
} from "../../../../shared/harnessPresets";
import { getModelById } from "../../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { providerColor } from "../../usage/providerColors";
import {
  harnessSubagentInheritNote,
  harnessSubagentSupport,
  type HarnessPresetAgentKey,
} from "../../../../shared/harnessPresets";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { SettingsDisclosure } from "../primitives/SettingsDisclosure";
import { SettingsSelect } from "../primitives/SettingsControls";
import { CustomHero, CustomHeroMark, RecipeCard } from "./CustomProviderHero";
import { ACCENT_SWATCHES, EffortPills, HarnessTiles, StepHead, recipeFor } from "./CustomProviderEditorParts";
import { ModernRow, ModernRows } from "../primitives/SettingsModern";
import { CustomProviderModelPane } from "./CustomProviderModelPane";
import { harnessAvailability } from "./harnessAvailability";
import { compactHarnessPresetLogo } from "../../../lib/harnessLogoCompaction";
import { HarnessLogoCropper } from "./HarnessLogoCropper";
import { buildTerminalLauncher } from "./harnessLauncher";
import {
  buildReachableGroups,
  defaultPresetName,
  findReachable,
  harnessChipOptions,
  harnessShortLabel,
  reachableKeyFor,
  type ReachableGroup,
  type ReachableModel,
} from "./harnessReach";
import { routeTestKey, type HarnessReach } from "./useHarnessReach";
import { FieldError } from "./wizardPrimitives";

/**
 * Create or edit a Custom provider, on one page.
 *
 * Top to bottom it is the order of the decision: which harness runs it, which
 * model it thinks with (the same grouped list the composer's picker shows, so
 * nothing here is reachable that the picker would not offer), how hard it
 * thinks, and what it is called. Save is live as soon as a harness and a model
 * are chosen; a blank name saves as "<model> in <harness>".
 *
 * No permission tier lives here: that belongs to the harness and is chosen at
 * launch, exactly as for a built-in provider.
 */

const ADVANCED_FOLLOWS = "follows";

type PresetsBridge = {
  generateLogo?: (args: { name: string; harness: string; accentColor: string }) => Promise<{ dataUrl: string }>;
};

function presetsBridge(): PresetsBridge | undefined {
  return (window as unknown as { ade?: { presets?: PresetsBridge } }).ade?.presets;
}

export function emptyCustomProviderDraft(harness: HarnessPresetBody = "claude"): HarnessPresetDraft {
  return {
    name: "",
    harness,
    source: { kind: "account", provider: "claude", instanceId: "claude" },
    model: "",
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    agentEfforts: {},
    accentColor: normalizeHex(providerColor(harness)),
    logo: { kind: "ade" },
  };
}

/**
 * The pins a harness still means something by, after switching to `harness`.
 *
 * A pin names a role; each harness spells its roles its own way, and one with
 * no such role would silently keep a setting nothing reads. Dropping them is
 * the same answer the model reset gives when a harness cannot reach a model.
 */
function keepAgentKeys<T extends Partial<Record<HarnessPresetAgentKey, unknown>>>(
  pins: T,
  harness: HarnessPresetBody,
): T {
  const kept = {} as T;
  for (const agent of harnessSubagentSupport(harness).agentTypes) {
    const value = pins[agent.key];
    if (value !== undefined) (kept as Record<string, unknown>)[agent.key] = value;
  }
  return kept;
}

/** One sentence for a save that threw, rather than a form that froze. */
function saveFailureText(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return detail.trim()
    || "The save could not be completed. Try again.";
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : DEFAULT_HARNESS_PRESET_ACCENT;
}

export function CustomProviderDialog({
  open,
  initialDraft,
  editingPresetId = null,
  missing = [],
  status,
  reach,
  onClose,
  onSave,
  onRetryAccountSync,
}: {
  open: boolean;
  initialDraft: HarnessPresetDraft;
  /** Set for Edit; enables the terminal launcher (it needs a saved id). */
  editingPresetId?: string | null;
  /** What an imported provider is missing on this computer. */
  missing?: readonly HarnessPresetMissing[];
  status: AiSettingsStatus | null;
  reach: HarnessReach;
  onClose: () => void;
  /**
   * Save, and answer what the account said. A non-null string is the reason the
   * brain has not confirmed the write; the dialog stays open and shows it,
   * because a preset the launch resolver cannot see yet is worth knowing about
   * before the first launch, not after it.
   */
  onSave: (draft: HarnessPresetDraft) => Promise<string | null>;
  /** Push the saved list to the account again, without writing anything locally. */
  onRetryAccountSync: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<HarnessPresetDraft>(initialDraft);
  const [query, setQuery] = useState("");
  /** Which source the model pane browses; null follows the draft's own source. */
  const [browsedSourceKey, setBrowsedSourceKey] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [compactingLogo, setCompactingLogo] = useState(false);
  /**
   * The local write has happened.
   *
   * The dialog stays open when the account has not confirmed the write, so the
   * primary action becomes Retry — which only re-pushes. Without this, pressing
   * Save again after a successful retry would write a SECOND preset, because
   * the first Save really did save.
   */
  const [written, setWritten] = useState(false);
  const [generating, setGenerating] = useState(false);
  const logoCompactionGenerationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Accent follows the harness until the person picks one of their own.
  const accentTouchedRef = useRef(initialDraft.accentColor !== normalizeHex(providerColor(initialDraft.harness)));

  useEffect(() => {
    logoCompactionGenerationRef.current += 1;
    setCompactingLogo(false);
    if (!open) {
      setCropSrc(null);
      return;
    }
    setDraft(initialDraft);
    setQuery("");
    setBrowsedSourceKey(null);
  }, [initialDraft, open]);

  useEffect(() => () => {
    logoCompactionGenerationRef.current += 1;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const groups = useMemo(() => buildReachableGroups(draft.harness, reach), [draft.harness, reach]);
  const selectedKey = useMemo(
    () => (draft.model ? reachableKeyFor(groups, draft.source, draft.model) : null),
    [draft.model, draft.source, groups],
  );
  const selected = useMemo(() => findReachable(groups, selectedKey), [groups, selectedKey]);
  /**
   * Which source the model pane shows. The draft's own source by default; a
   * click on the rail browses another without touching the draft, so looking
   * at another provider's models cannot change what would be saved.
   */
  const activeGroup = useMemo(() => {
    const browsed = browsedSourceKey ? groups.find((group) => group.key === browsedSourceKey) : undefined;
    // With nothing picked yet, open on another provider's models: the
    // harness's own account is what its built-in picker already offers, and
    // a new custom provider is usually about mixing the two.
    return browsed
      ?? selected?.group
      ?? groups.find((group) => group.kind === "subscription" && group.source.kind === "account" && !group.signedOut && group.models.length > 0)
      ?? groups.find((group) => group.models.length > 0 && group.kind !== "native" && !group.signedOut)
      ?? groups.find((group) => group.models.length > 0)
      ?? groups[0]
      ?? null;
  }, [browsedSourceKey, groups, selected]);
  const availability = harnessAvailability(draft.harness, status);
  const chipOptions = useMemo(() => harnessChipOptions("chat"), []);

  const patch = useCallback((next: Partial<HarnessPresetDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const selectLogo = useCallback((logo: HarnessPresetLogo) => {
    logoCompactionGenerationRef.current += 1;
    setCompactingLogo(false);
    patch({ logo });
  }, [patch]);

  const chooseHarness = useCallback((harness: HarnessPresetBody) => {
    setDraft((prev) => {
      if (prev.harness === harness) return prev;
      // Keep the model when the new harness can still reach it from the same
      // source; otherwise the pick means nothing there.
      const nextGroups = buildReachableGroups(harness, reach);
      const keeps = prev.model ? reachableKeyFor(nextGroups, prev.source, prev.model) != null : false;
      return {
        ...prev,
        harness,
        ...(keeps ? {}
          : {
            model: "",
            reasoningEffort: undefined,
            subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
            subagentEffort: undefined,
          }),
        // Pins are keyed by role, and each harness spells its roles its own
        // way, so a pin (or a level) left on a harness that has no such role
        // would save a setting nothing reads.
        ...(keeps ? {} : {
          agentOverrides: keepAgentKeys(prev.agentOverrides, harness),
          agentEfforts: keepAgentKeys(prev.agentEfforts, harness),
        }),
        accentColor: accentTouchedRef.current ? prev.accentColor : normalizeHex(providerColor(harness)),
      };
    });
  }, [reach]);

  const chooseModel = useCallback((group: ReachableGroup, model: ReachableModel) => {
    // The pane follows the pick: when a cross-source search clears, the list
    // must show the source the chosen model came from, or the selection looks
    // like it vanished.
    setBrowsedSourceKey(group.key);
    setDraft((prev) => {
      const sameGroup = selected?.group.key === group.key;
      return {
        ...prev,
        source: group.source,
        model: model.id,
        // An effort the new model does not offer would be rejected at launch.
        ...(prev.reasoningEffort && !(model.reasoningTiers ?? []).includes(prev.reasoningEffort)
          ? { reasoningEffort: undefined }
          : {}),
        // Subagents run on the same endpoint as main, so a pick from another
        // source cannot survive a source change.
        ...(sameGroup
          ? {}
          : {
            subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
            subagentEffort: undefined,
            agentOverrides: {},
            agentEfforts: {},
          }),
        // A subagent level belongs to the SUBAGENT's model. Clearing it against
        // the model just picked for the main thread would drop a level that is
        // still offered where it applies — pinning a subagent model that takes
        // `max` and then switching the main model to one that does not used to
        // clear it. Only an inheriting subagent (`Same as main`, or a reset
        // because the source changed) follows the main model's tiers.
        ...(prev.subagentEffort
          && (sameGroup || prev.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT)
          && !(model.reasoningTiers ?? []).includes(prev.subagentEffort)
          ? { subagentEffort: undefined }
          : {}),
      };
    });
  }, [selected?.group.key]);

  const handleTest = useCallback((group: ReachableGroup, model: ReachableModel) => {
    if (!group.routeSource) return;
    void reach.testRoute(draft.harness, group.routeSource.source, model.id);
  }, [draft.harness, reach]);

  // Picking a source is a request to look at that source, so an active search
  // (which spans every source) gives way to the rail's scope.
  const selectSource = useCallback((key: string) => {
    setBrowsedSourceKey(key);
    setQuery("");
  }, []);

  const testStateFor = useCallback(
    (group: ReachableGroup, model: ReachableModel) =>
      group.routeSource ? reach.testState[routeTestKey(draft.harness, group.routeSource.source, model.id)] : undefined,
    [draft.harness, reach.testState],
  );

  const handleFile = useCallback((file: File | null | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setLogoError("Pick a PNG, JPEG, or WebP image.");
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setCropSrc(url);
  }, []);

  const generate = presetsBridge()?.generateLogo;
  const handleGenerate = useCallback(async () => {
    if (typeof generate !== "function") return;
    setGenerating(true);
    setLogoError(null);
    try {
      const result = await generate({ name: draft.name, harness: draft.harness, accentColor: draft.accentColor });
      if (result?.dataUrl) patch({ logo: await compactHarnessPresetLogo({ kind: "generated", dataUrl: result.dataUrl }) });
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "The logo could not be generated.");
    } finally {
      setGenerating(false);
    }
  }, [draft.accentColor, draft.harness, draft.name, generate, patch]);

  const modelLabel = selected?.model.label ?? (draft.model ? getModelById(draft.model)?.displayName ?? draft.model : "");
  const fallbackName = draft.model ? defaultPresetName(modelLabel, draft.harness) : "";
  const finalDraft: HarnessPresetDraft = { ...draft, name: draft.name.trim() || fallbackName };
  const errors = validateHarnessPreset(finalDraft);
  const canSave = Object.keys(errors).length === 0 && !compactingLogo;

  // The launcher starts the SAVED preset (the CLI resolves it by id), so it is
  // built from what is saved, not from unsaved edits in this dialog.
  const launcher = editingPresetId
    ? buildTerminalLauncher({
      presetId: editingPresetId,
      harness: initialDraft.harness,
      model: initialDraft.model,
      source: initialDraft.source,
      ...(initialDraft.reasoningEffort ? { reasoningEffort: initialDraft.reasoningEffort } : {}),
    })
    : null;

  const subagentChoices = useMemo(() => selected?.group.models ?? [], [selected]);
  const subagentSupport = harnessSubagentSupport(draft.harness);
  // The subagent's own model decides which levels exist, exactly as the main
  // model's does — a level the model does not advertise is refused at launch.
  const subagentTiersFor = useCallback((model: string): readonly string[] => {
    const listed = subagentChoices.find((choice) => choice.id === model || choice.launchModelId === model);
    return listed?.reasoningTiers ?? getModelById(model)?.reasoningTiers ?? [];
  }, [subagentChoices]);
  // "Same as main" means the level menu belongs to the main model.
  const subagentEffortTiers = useMemo(
    () => (draft.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT
      ? (selected?.model.reasoningTiers ?? [])
      : subagentTiersFor(draft.subagentModel)),
    [draft.subagentModel, selected?.model.reasoningTiers, subagentTiersFor],
  );
  const agentEffortTiers = useCallback(
    (value: string): readonly string[] => (
      value === ADVANCED_FOLLOWS ? subagentEffortTiers : subagentTiersFor(value)
    ),
    [subagentEffortTiers, subagentTiersFor],
  );
  const registryTiers = draft.model ? getModelById(draft.model)?.reasoningTiers ?? [] : [];
  const listedTiers = selected?.model.reasoningTiers ?? [];
  // A model that is not in the list anymore (an import, a key removed since)
  // is still named, so the reader knows what the preset points at.
  const orphaned = Boolean(draft.model) && !selected && !reach.loading;

  const logoChoices: Array<{ id: HarnessPresetLogo["kind"]; label: string; onSelect: () => void }> = [
    { id: "ade", label: "Custom", onSelect: () => selectLogo({ kind: "ade" }) },
    { id: "provider", label: harnessShortLabel(draft.harness), onSelect: () => selectLogo({ kind: "provider", providerId: draft.harness }) },
    { id: "upload", label: "Upload", onSelect: () => fileInputRef.current?.click() },
    ...(typeof generate === "function"
      ? [{ id: "generated" as const, label: generating ? "Generating…" : "Generate", onSelect: () => void handleGenerate() }]
      : []),
  ];

  const recipe = recipeFor(draft, selected, modelLabel);
  const mainTiers = registryTiers.length > 0 ? registryTiers : listedTiers;
  const subagentsCustomised = draft.subagentModel !== HARNESS_PRESET_SUBAGENT_INHERIT
    || Boolean(draft.subagentEffort)
    || Object.keys(draft.agentOverrides).length > 0;
  const accentStyle = { "--cp-accent": draft.accentColor } as React.CSSProperties;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={editingPresetId ? `Edit ${initialDraft.name || "custom provider"}` : "New custom provider"}
        hideHeader
        width={800}
        maxHeight="min(820px, calc(100vh - 40px))"
        testId="custom-provider-dialog"
        footerStart={launcher ? (
          <button
            type="button"
            data-custom-copy-launcher=""
            onClick={() => {
              void copyTextToClipboard(launcher).then((ok) =>
                showToast(ok
                  ? { tone: "success", title: "Launcher copied", message: "Paste it in any terminal. It holds no key." }
                  : { tone: "error", title: "Could not copy the launcher" }),
              );
            }}
            style={linkButtonStyle}
          >
            <Terminal size={13} /> Copy terminal launcher
          </button>
        ) : undefined}
        actions={[
          { label: "Cancel", variant: "secondary", onClick: onClose },
          accountError
            ? {
                label: saving ? "Retrying…" : "Retry",
                variant: "solid",
                disabled: saving,
                onClick: () => {
                  if (saving) return;
                  setSaving(true);
                  void onRetryAccountSync()
                    .then((error) => {
                      setAccountError(error);
                      // Confirmed: there is nothing left to do here, and
                      // leaving Save on screen would invite a second write.
                      if (!error) onClose();
                    })
                    // A rejected push is reported like a refused one. Letting
                    // it escape would leave the warning cleared and the form
                    // frozen with nothing on screen to explain either.
                    .catch((error: unknown) => setAccountError(saveFailureText(error)))
                    .finally(() => setSaving(false));
                },
              }
            : written
              ? { label: "Close", variant: "solid", onClick: onClose }
              : {
                  label: editingPresetId ? "Save" : "Create",
                  variant: "solid",
                  disabled: !canSave || saving || generating,
                  onClick: () => {
                    if (!canSave || saving || generating) return;
                    setSaving(true);
                    setWritten(true);
                    void onSave(finalDraft)
                      .then((error) => setAccountError(error))
                      .catch((error: unknown) => setAccountError(saveFailureText(error)))
                      .finally(() => setSaving(false));
                  },
                },
        ]}
      >
        {/* A frozen form after a write.
            The local save really happened, so what the account will receive is
            what is on screen NOW. Letting the fields keep moving while the
            warning shows would let someone rename a preset, press Retry, and
            watch a confirmation for the name they just replaced. */}
        <fieldset
          disabled={written}
          data-custom-provider-editor=""
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 22,
            fontFamily: SANS_FONT,
            minWidth: 0,
            margin: 0,
            padding: 0,
            border: "none",
            ...accentStyle,
          }}
        >
          <CustomHero color={draft.accentColor} label="Preview">
            <CustomHeroMark logo={draft.logo} />
            <div className="ade-cp-hero-id">
              <span className="ade-cp-hero-eyebrow">{editingPresetId ? "Custom provider" : "New custom provider"}</span>
              <input
                id="custom-provider-name"
                className="ade-cp-name"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH) })}
                placeholder={fallbackName || "Name it"}
                aria-label="Name"
                spellCheck={false}
              />
              <span className="ade-cp-hero-copy">
                One pick in every model picker, on every computer you sign in to.
              </span>
            </div>
            <RecipeCard harness={draft.harness} model={recipe.model} source={recipe.source} note={recipe.note} />
          </CustomHero>
          {errors.name && draft.name.trim() ? <FieldError>{errors.name}</FieldError> : null}

          {accountError ? (
            <Banner
              layout="inline"
              model={{
                id: "custom-provider-account-sync",
                tone: "warning",
                title: "Saved on this computer, but not on your ADE account yet",
                detail: `${accountError} Until it reaches the account, another computer may not have it. Retry to send it again.`,
              }}
            />
          ) : null}
          {missing.length > 0 ? (
            <Banner
              layout="inline"
              model={{
                id: "custom-provider-missing",
                tone: "warning",
                title: "This one needs something this computer does not have yet",
                detail: missing.map((entry) => harnessPresetMissingCopy(entry)).join(" "),
              }}
            />
          ) : null}

          <section aria-label="Harness" className="ade-cp-step">
            <StepHead n={1} done title="Harness" hint="The coding agent that runs the chat." />
            <HarnessTiles options={chipOptions} selected={draft.harness} onSelect={chooseHarness} />
            {!availability.available ? (
              <Banner
                layout="inline"
                model={{
                  id: "custom-provider-harness-unavailable",
                  tone: "warning",
                  title: `${availability.reason} You can still save it.`,
                }}
              />
            ) : null}
          </section>

          <section aria-label="Model" className="ade-cp-step">
            <StepHead
              n={2}
              done={Boolean(selected)}
              title="Model"
              hint={`Anything you already pay for, running inside ${harnessShortLabel(draft.harness)}.`}
            />
            <CustomProviderModelPane
              groups={groups}
              activeGroup={activeGroup}
              selectedKey={selectedKey}
              query={query}
              onQueryChange={setQuery}
              onSelectSource={selectSource}
              onSelectModel={chooseModel}
              onTest={handleTest}
              testStateFor={testStateFor}
              loading={reach.loading}
              harnessLabel={harnessBodyLabel(draft.harness)}
            />
            {orphaned ? (
              <Banner
                layout="inline"
                model={{
                  id: "custom-provider-model-unreachable",
                  tone: "warning",
                  title: `Saved model ${draft.model} from ${presetSourceLabel(draft.source)} is not reachable in ${harnessBodyLabel(draft.harness)} on this computer. Pick one above.`,
                }}
              />
            ) : null}
          </section>

          {draft.model ? (
            <section aria-label="Thinking" className="ade-cp-step">
              <StepHead n={3} done title="Thinking" hint="How hard it thinks, and what its helpers use." />
              <ModernRows>
                <ModernRow
                  title="Effort"
                  hint="Default lets the model decide."
                  control={mainTiers.length > 0 ? (
                    <EffortPills
                      tiers={mainTiers}
                      value={draft.reasoningEffort ?? ""}
                      onChange={(value) => patch({ reasoningEffort: value || undefined })}
                    />
                  ) : (
                    <span style={noteStyle}>Model default</span>
                  )}
                />
                {subagentSupport.model ? (
                  <details className="ade-cp-more" open={subagentsCustomised || undefined}>
                    <summary>
                      <CaretRight size={11} weight="bold" />
                      Subagents
                      <span style={{ marginLeft: "auto", color: COLORS.textMuted }}>
                        {draft.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT
                          ? "Same as main"
                          : subagentChoices.find((choice) => choice.id === draft.subagentModel)?.label ?? draft.subagentModel}
                      </span>
                    </summary>
                    <div className="ade-cp-more-body">
                      <div style={rowStyle}>
                        <label htmlFor="custom-provider-subagents" style={rowLabelStyle}>Model</label>
                        <SettingsSelect
                          id="custom-provider-subagents"
                          ariaLabel="Subagent model"
                          value={draft.subagentModel}
                          options={[
                            { value: HARNESS_PRESET_SUBAGENT_INHERIT, label: "Same as main" },
                            ...subagentChoices.map((choice) => ({ value: choice.id, label: choice.label })),
                          ]}
                          onChange={(value) => patch({
                            subagentModel: value,
                            ...(value === HARNESS_PRESET_SUBAGENT_INHERIT ? { subagentEffort: undefined } : {}),
                          })}
                        />
                      </div>
                      {subagentSupport.effort ? (
                        <div style={rowStyle}>
                          <span style={rowLabelStyle}>Effort</span>
                          {subagentEffortTiers.length > 0 ? (
                            <EffortPills
                              tiers={subagentEffortTiers}
                              value={draft.subagentEffort ?? ""}
                              onChange={(value) => patch({ subagentEffort: value || undefined })}
                            />
                          ) : (
                            <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>Model default</span>
                          )}
                        </div>
                      ) : (
                        <p style={noteStyle}>{harnessSubagentInheritNote(draft.harness, "effort")}</p>
                      )}
                      {subagentSupport.agentTypes.length > 0 ? (
                        <SettingsDisclosure summary="Per subagent" gap={10}>
                          {subagentSupport.agentTypes.map(({ key, label }) => {
                            const value = draft.agentOverrides[key] ?? ADVANCED_FOLLOWS;
                            const effort = draft.agentEfforts[key] ?? "";
                            return (
                              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={rowStyle}>
                                  <label htmlFor={`custom-provider-agent-${key}`} style={rowLabelStyle}>
                                    {label}
                                  </label>
                                  <SettingsSelect
                                    id={`custom-provider-agent-${key}`}
                                    ariaLabel={`${label} model`}
                                    value={value}
                                    options={[
                                      { value: ADVANCED_FOLLOWS, label: "Follows subagents" },
                                      ...subagentChoices.map((choice) => ({ value: choice.id, label: choice.label })),
                                    ]}
                                    onChange={(next) => {
                                      const overrides = { ...draft.agentOverrides };
                                      if (next === ADVANCED_FOLLOWS) delete overrides[key];
                                      else overrides[key] = next;
                                      const efforts = { ...draft.agentEfforts };
                                      if (next === ADVANCED_FOLLOWS) delete efforts[key];
                                      patch({ agentOverrides: overrides, agentEfforts: efforts });
                                    }}
                                  />
                                </div>
                                {subagentSupport.effort && value !== ADVANCED_FOLLOWS ? (
                                  <div style={rowStyle}>
                                    <span style={{ ...rowLabelStyle, color: COLORS.textMuted }}>Effort</span>
                                    {agentEffortTiers(value).length > 0 ? (
                                      <EffortPills
                                        tiers={agentEffortTiers(value)}
                                        value={effort}
                                        onChange={(next) => {
                                          const efforts = { ...draft.agentEfforts };
                                          if (next) efforts[key] = next;
                                          else delete efforts[key];
                                          patch({ agentEfforts: efforts });
                                        }}
                                      />
                                    ) : (
                                      <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>Follows subagents</span>
                                    )}
                                  </div>
                                ) : null}
                                {value !== ADVANCED_FOLLOWS ? (
                                  <p style={noteStyle}>{harnessPresetAgentOverrideNote(key)}</p>
                                ) : null}
                              </div>
                            );
                          })}
                        </SettingsDisclosure>
                      ) : null}
                    </div>
                  </details>
                ) : (
                  <ModernRow title="Subagents" hint={harnessSubagentInheritNote(draft.harness, "model")} />
                )}
              </ModernRows>
            </section>
          ) : null}

          <section aria-label="Look" className="ade-cp-step">
            <StepHead n={draft.model ? 4 : 3} done title="Look" hint="How it shows up in model pickers." />
            <div className="ade-cp-look">
              <div role="radiogroup" aria-label="Logo" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {logoChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.logo.kind === choice.id}
                    data-custom-logo-tile={choice.id}
                    onClick={choice.onSelect}
                    disabled={choice.id === "generated" && generating}
                    className="ade-cp-logo-choice"
                  >
                    {choice.id === "upload" ? (
                      <UploadSimple size={13} />
                    ) : (
                      <HarnessLogo
                        logo={
                          choice.id === "provider"
                            ? { kind: "provider", providerId: draft.harness }
                            : choice.id === "generated" && draft.logo.kind === "generated"
                              ? draft.logo
                              : { kind: "ade" }
                        }
                        size={14}
                        {...(choice.id === "ade" ? { accentColor: null } : {})}
                      />
                    )}
                    {choice.label}
                  </button>
                ))}
              </div>
              <div role="radiogroup" aria-label="Colour" className="ade-cp-swatches">
                {ACCENT_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    role="radio"
                    aria-checked={draft.accentColor === swatch}
                    aria-label={`Colour ${swatch}`}
                    className="ade-cp-swatch"
                    style={{ "--swatch": swatch } as React.CSSProperties}
                    onClick={() => {
                      accentTouchedRef.current = true;
                      patch({ accentColor: swatch });
                    }}
                  />
                ))}
                <label
                  className="ade-cp-swatch-custom"
                  data-active={ACCENT_SWATCHES.includes(draft.accentColor) ? undefined : "true"}
                  title="Any colour"
                >
                  <input
                    type="color"
                    aria-label="Accent"
                    value={draft.accentColor}
                    onChange={(event) => {
                      accentTouchedRef.current = true;
                      patch({ accentColor: event.target.value.toLowerCase() });
                    }}
                  />
                </label>
              </div>
            </div>
            {errors.accentColor ? <FieldError>{errors.accentColor}</FieldError> : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload a logo"
              style={{ display: "none" }}
              onChange={(event) => {
                handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            {compactingLogo ? (
              <p style={{ margin: 0, fontSize: 11, color: COLORS.textMuted }}>Preparing logo…</p>
            ) : null}
            {logoError ? <FieldError>{logoError}</FieldError> : null}
          </section>
        </fieldset>
      </Dialog>

      {cropSrc ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setCropSrc(null);
          }}
          title="Crop the logo"
          size="sm"
          layer="nestedDialog"
        >
          <HarnessLogoCropper
            imageSrc={cropSrc}
            onCancel={() => setCropSrc(null)}
            onConfirm={(dataUrl) => {
              setCropSrc(null);
              const generation = ++logoCompactionGenerationRef.current;
              setCompactingLogo(true);
              setLogoError(null);
              // Shrunk to an icon before it is kept: the preset list syncs as
              // one small setting, and a full-size image keeps it off the account.
              void compactHarnessPresetLogo({ kind: "upload", dataUrl })
                .then((logo) => {
                  if (generation !== logoCompactionGenerationRef.current) return;
                  if (logo.kind === "upload") patch({ logo });
                  else setLogoError("This image could not be shrunk to a logo. Try another one.");
                })
                .catch((error: unknown) => {
                  if (generation === logoCompactionGenerationRef.current) {
                    setLogoError(error instanceof Error ? error.message : "This image could not be shrunk to a logo. Try another one.");
                  }
                })
                .finally(() => {
                  if (generation === logoCompactionGenerationRef.current) setCompactingLogo(false);
                });
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 };
const rowLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: COLORS.textPrimary };
const noteStyle: React.CSSProperties = { margin: 0, fontSize: 11, lineHeight: 1.5, color: COLORS.textMuted };
const linkButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: 0,
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 11.5,
  cursor: "pointer",
};
