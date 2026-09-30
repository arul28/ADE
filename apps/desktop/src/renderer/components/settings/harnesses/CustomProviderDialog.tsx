import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, Terminal, UploadSimple } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_AGENT_LABELS,
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
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { HarnessChipRow, ReachableModelList } from "../../shared/ModelPicker/ReachableModelList";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { SettingsDisclosure } from "../primitives/SettingsDisclosure";
import { SettingsSelect, SettingsTextField } from "../primitives/SettingsControls";
import { harnessAvailability } from "./harnessAvailability";
import { HarnessLogoCropper } from "./HarnessLogoCropper";
import { buildTerminalLauncher } from "./harnessLauncher";
import {
  buildReachableGroups,
  defaultPresetName,
  findReachable,
  harnessChipOptions,
  reachableKeyFor,
  type ReachableGroup,
  type ReachableModel,
} from "./harnessReach";
import { routeTestKey, type HarnessReach } from "./useHarnessReach";
import { FieldError, SectionLabel } from "./wizardPrimitives";

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
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Accent follows the harness until the person picks one of their own.
  const accentTouchedRef = useRef(initialDraft.accentColor !== normalizeHex(providerColor(initialDraft.harness)));

  useEffect(() => {
    setDraft(initialDraft);
    setQuery("");
  }, [initialDraft]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const groups = useMemo(() => buildReachableGroups(draft.harness, reach), [draft.harness, reach]);
  const selectedKey = useMemo(
    () => (draft.model ? reachableKeyFor(groups, draft.source, draft.model) : null),
    [draft.model, draft.source, groups],
  );
  const selected = useMemo(() => findReachable(groups, selectedKey), [groups, selectedKey]);
  const availability = harnessAvailability(draft.harness, status);
  const chipOptions = useMemo(() => harnessChipOptions("chat"), []);

  const patch = useCallback((next: Partial<HarnessPresetDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

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
      if (result?.dataUrl) patch({ logo: { kind: "generated", dataUrl: result.dataUrl } });
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
  const canSave = Object.keys(errors).length === 0;

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

  const subagentChoices = selected?.group.models ?? [];
  const subagentSupport = harnessSubagentSupport(draft.harness);
  // The subagent's own model decides which levels exist, exactly as the main
  // model's does — a level the model does not advertise is refused at launch.
  const subagentTiersFor = useCallback((model: string): readonly string[] => {
    const listed = subagentChoices.find((choice) => choice.id === model || choice.launchModelId === model);
    return listed?.reasoningTiers ?? getModelById(model)?.reasoningTiers ?? [];
  }, [subagentChoices]);
  // "Same as main" means the level menu belongs to the main model.
  const subagentEffortTiers = draft.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT
    ? (selected?.model.reasoningTiers ?? [])
    : subagentTiersFor(draft.subagentModel);
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

  const tiles: Array<{ id: HarnessPresetLogo["kind"]; label: string; onSelect: () => void }> = [
    { id: "ade", label: "Default", onSelect: () => patch({ logo: { kind: "ade" } }) },
    { id: "provider", label: "Harness mark", onSelect: () => patch({ logo: { kind: "provider", providerId: draft.harness } }) },
    { id: "upload", label: "Upload", onSelect: () => fileInputRef.current?.click() },
    ...(typeof generate === "function"
      ? [{ id: "generated" as const, label: generating ? "Generating…" : "Generate", onSelect: () => void handleGenerate() }]
      : []),
  ];

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={editingPresetId ? `Edit ${initialDraft.name || "custom provider"}` : "New custom provider"}
        description="A harness and the model it runs on, saved as one choice for any model picker."
        size="lg"
        maxHeight="min(760px, calc(100vh - 48px))"
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
                    .finally(() => setSaving(false));
                },
              }
            : written
              ? { label: "Close", variant: "solid", onClick: onClose }
              : {
                  label: editingPresetId ? "Save" : "Create",
                  variant: "solid",
                  disabled: !canSave || saving,
                  onClick: () => {
                    if (!canSave || saving) return;
                    setSaving(true);
                    setWritten(true);
                    void onSave(finalDraft)
                      .then((error) => setAccountError(error))
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
            gap: 18,
            fontFamily: SANS_FONT,
            minWidth: 0,
            margin: 0,
            padding: 0,
            border: "none",
          }}
        >
          {accountError ? (
            <Banner
              layout="inline"
              model={{
                id: "custom-provider-account-sync",
                tone: "warning",
                title: "Saved on this computer, but not on your ADE account yet",
                detail: `${accountError} Until it reaches the account, a chat launched on it now falls back to the harness's own sign-in. Retry to send it again.`,
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

          <section aria-label="Harness" style={sectionStyle}>
            <SectionLabel>Harness</SectionLabel>
            <HarnessChipRow options={chipOptions} selected={draft.harness} onSelect={chooseHarness} size="md" label="Harness" />
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

          <section aria-label="Model" style={sectionStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SectionLabel>Model</SectionLabel>
              <label
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: 240,
                  height: 26,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  background: COLORS.recessedBg,
                }}
              >
                <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search what ${harnessBodyLabel(draft.harness)} can run`}
                  aria-label="Search models"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    fontSize: 11.5,
                  }}
                />
              </label>
            </div>
            <div
              style={{
                maxHeight: 280,
                overflowY: "auto",
                padding: "4px 2px",
                borderRadius: 8,
                border: `1px solid ${COLORS.borderMuted}`,
                background: COLORS.recessedBg,
              }}
            >
              <ReachableModelList
                groups={groups}
                query={query}
                loading={reach.loading}
                selectedKey={selectedKey}
                onSelect={chooseModel}
                onTest={handleTest}
                testStateFor={testStateFor}
                standalone
                onProxySignIn={(provider) => void reach.proxySignIn(provider)}
                proxySignInAvailable={reach.proxyAvailable}
                proxySigningIn={reach.proxySigningIn}
                emptyState={
                  <>
                    {harnessBodyLabel(draft.harness)} has nothing to run from your connections yet. Sign in to
                    OpenCode Go or Zen, or store an API key, under Providers.
                  </>
                }
              />
            </div>
            {selected ? (
              <span data-custom-selected-model="true" style={{ fontSize: 11.5, color: COLORS.textSecondary }}>
                Selected: <strong style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{selected.model.label}</strong>
                {" · "}
                {selected.group.label}
                {selected.model.route.kind === "proxy" ? " · via ADE proxy" : ""}
              </span>
            ) : null}
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
            <section aria-label="Thinking" style={{ ...sectionStyle, gap: 10 }}>
              <SectionLabel>Thinking</SectionLabel>
              <div style={rowStyle}>
                <span style={rowLabelStyle}>Effort</span>
                {registryTiers.length > 0 ? (
                  <ReasoningEffortPicker
                    modelId={draft.model}
                    reasoningEffort={draft.reasoningEffort ?? null}
                    useFamilyDefaults={false}
                    onChange={(effort) => patch({ reasoningEffort: effort || undefined })}
                  />
                ) : listedTiers.length > 0 ? (
                  <EffortPills
                    tiers={listedTiers}
                    value={draft.reasoningEffort ?? ""}
                    onChange={(value) => patch({ reasoningEffort: value || undefined })}
                  />
                ) : (
                  <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>Model default</span>
                )}
              </div>
              {subagentSupport.model ? (
                <>
                  <div style={rowStyle}>
                    <label htmlFor="custom-provider-subagents" style={rowLabelStyle}>Subagents</label>
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
                      <span style={rowLabelStyle}>Subagent effort</span>
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
                    <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}>
                      {harnessSubagentInheritNote(draft.harness, "effort")}
                    </p>
                  )}
                  {subagentSupport.agentTypes.length > 0 ? (
                    <SettingsDisclosure summary="Subagent naming" gap={10}>
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
                              <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}>
                                {harnessPresetAgentOverrideNote(key)}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                    </SettingsDisclosure>
                  ) : null}
                </>
              ) : (
                <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}>
                  {harnessSubagentInheritNote(draft.harness, "model")}
                </p>
              )}
            </section>
          ) : null}

          <section aria-label="Name and look" style={{ ...sectionStyle, gap: 10 }}>
            <SectionLabel>Name and look</SectionLabel>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <HarnessLogo logo={draft.logo} size={26} accentColor={draft.accentColor} />
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <SettingsTextField
                  id="custom-provider-name"
                  value={draft.name}
                  onChange={(value) => patch({ name: value.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH) })}
                  placeholder={fallbackName || "Name"}
                  ariaLabel="Name"
                />
              </div>
              <input
                type="color"
                aria-label="Accent"
                title="Accent"
                value={draft.accentColor}
                onChange={(event) => {
                  accentTouchedRef.current = true;
                  patch({ accentColor: event.target.value.toLowerCase() });
                }}
                style={{
                  width: 34,
                  height: 28,
                  padding: 0,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  borderRadius: 7,
                  background: "transparent",
                  cursor: "pointer",
                }}
              />
            </div>
            {errors.name && draft.name.trim() ? <FieldError>{errors.name}</FieldError> : null}
            {errors.accentColor ? <FieldError>{errors.accentColor}</FieldError> : null}
            <div role="radiogroup" aria-label="Logo" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {tiles.map((tile) => {
                const isSelected = draft.logo.kind === tile.id;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-custom-logo-tile={tile.id}
                    onClick={tile.onSelect}
                    disabled={tile.id === "generated" && generating}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      height: 28,
                      padding: "0 10px",
                      borderRadius: 7,
                      cursor: "pointer",
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      color: COLORS.textPrimary,
                      border: `1px solid ${isSelected ? draft.accentColor : COLORS.outlineBorder}`,
                      background: isSelected ? `color-mix(in srgb, ${draft.accentColor} 12%, transparent)` : "transparent",
                    }}
                  >
                    {tile.id === "upload" ? (
                      <UploadSimple size={13} />
                    ) : (
                      <HarnessLogo
                        logo={
                          tile.id === "provider"
                            ? { kind: "provider", providerId: draft.harness }
                            : tile.id === "generated" && draft.logo.kind === "generated"
                              ? draft.logo
                              : { kind: "ade" }
                        }
                        size={14}
                      />
                    )}
                    {tile.label}
                  </button>
                );
              })}
            </div>
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
              patch({ logo: { kind: "upload", dataUrl } });
              setCropSrc(null);
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

const sectionStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 };
const rowLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: COLORS.textPrimary };
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


/**
 * The model's own thinking tiers as one row of pills. A handful of tiers reads
 * faster as buttons than behind a dropdown, and "Model default" stays one
 * click away.
 */
function EffortPills({
  tiers,
  value,
  onChange,
}: {
  tiers: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const options = [{ value: "", label: "Default" }, ...tiers.map((tier) => ({ value: tier, label: tier }))];
  return (
    <div role="radiogroup" aria-label="Effort" style={{ display: "inline-flex", gap: 4 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value || "default"}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            style={{
              height: 26,
              padding: "0 10px",
              borderRadius: 6,
              border: `1px solid ${active ? COLORS.accent : COLORS.outlineBorder}`,
              background: active ? COLORS.accentSubtle : "transparent",
              color: active ? COLORS.textPrimary : COLORS.textSecondary,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              textTransform: option.value ? "capitalize" : "none",
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
