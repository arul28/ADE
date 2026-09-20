import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, Check, UploadSimple, Warning } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_AGENT_LABELS,
  HARNESS_PRESET_BODIES,
  HARNESS_PRESET_NAME_MAX_LENGTH,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  harnessBodyLabel,
  harnessPresetAgentOverrideNote,
  harnessPresetMissingCopy,
  validateHarnessPreset,
  type HarnessPresetBody,
  type HarnessPresetDraft,
  type HarnessPresetLogo,
  type HarnessPresetMissing,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { providerColor } from "../../usage/providerColors";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { PermissionModePicker } from "../../shared/PermissionModePicker";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { SettingsDisclosure } from "../primitives/SettingsDisclosure";
import { SettingsSelect, SettingsTextField } from "../primitives/SettingsControls";
import { harnessAvailabilityMap } from "./harnessAvailability";
import { harnessModelLabel, modelChoicesForSource, sourceNeedsFreeTextModel } from "./harnessModels";
import {
  coerceHarnessPermissionMode,
  defaultHarnessPermissionMode,
  harnessPermissionOptions,
} from "./harnessPermissionModes";
import {
  EMPTY_HARNESS_SOURCE_INVENTORY,
  HARNESS_PROXY_SIGN_IN_UNAVAILABLE,
  harnessSourceRowDetail,
  harnessSourceRowTitle,
  loadHarnessAccounts,
  proxySignInAvailable,
  readStoredKeySources,
  sourceFromInventoryRow,
  sourceMatchesRow,
  subscriptionSources,
  type HarnessBrainSource,
  type HarnessKeySource,
  type HarnessSourceInventory,
} from "./harnessSources";
import { HarnessLogoCropper } from "./HarnessLogoCropper";

/**
 * Building a harness: pick the body, pick the brain, name it.
 *
 * Three steps because there are exactly three decisions, and separating them is
 * what lets the middle step show a model list that already knows which provider
 * it is listing. The build animation is the point of the shape: the body card
 * slides in, and the brain card snaps onto it in the preset's accent, so the
 * thing you are assembling is visible the whole way through rather than being a
 * form you fill in and a row that appears afterwards.
 *
 * Unavailable harnesses stay selectable on purpose — see `harnessAvailability`.
 * A sign-in the host cannot perform is shown as a disabled button with the
 * reason on it; the wizard never fakes one.
 */

type Step = 1 | 2 | 3;

const ADVANCED_FOLLOWS = "follows";

/** Honour the user's motion setting without pulling in a hook library. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    if (!media) return;
    setReduced(media.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener?.("change", listener);
    return () => media.removeEventListener?.("change", listener);
  }, []);
  return reduced;
}

type PresetsBridge = {
  generateLogo?: (args: { name: string; harness: string; accentColor: string }) => Promise<{ dataUrl: string }>;
};

function presetsBridge(): PresetsBridge | undefined {
  return (window as unknown as { ade?: { presets?: PresetsBridge } }).ade?.presets;
}

export function emptyHarnessDraft(harness: HarnessPresetBody = "claude"): HarnessPresetDraft {
  return {
    name: "",
    harness,
    source: { kind: "account", provider: "claude", instanceId: "claude" },
    model: "",
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    permissionMode: defaultHarnessPermissionMode(harness),
    accentColor: DEFAULT_HARNESS_PRESET_ACCENT,
    logo: { kind: "ade" },
  };
}

export function HarnessWizard({
  initialDraft,
  editingPresetId = null,
  missing = [],
  status,
  storedProviders = [],
  credentialSummaries = [],
  onCancel,
  onSave,
}: {
  /** Prefilled for Edit and for Import; omitted for a fresh harness. */
  initialDraft?: HarnessPresetDraft;
  editingPresetId?: string | null;
  /** What an imported harness is missing on this computer. */
  missing?: readonly HarnessPresetMissing[];
  /** Provider probe, for harness availability and the stored-key list. */
  status: AiSettingsStatus | null;
  storedProviders?: readonly string[];
  /** Current non-secret credential rows from the local API-credential bridge. */
  credentialSummaries?: readonly ApiCredentialSummary[];
  onCancel: () => void;
  onSave: (draft: HarnessPresetDraft) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<HarnessPresetDraft>(() => initialDraft ?? emptyHarnessDraft());
  const [inventory, setInventory] = useState<HarnessSourceInventory>(EMPTY_HARNESS_SOURCE_INVENTORY);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const availability = useMemo(() => harnessAvailabilityMap(status), [status]);
  const keySources = useMemo(
    () => readStoredKeySources(status, storedProviders, credentialSummaries),
    [credentialSummaries, status, storedProviders],
  );

  useEffect(() => {
    let cancelled = false;
    void loadHarnessAccounts().then((accounts) => {
      if (cancelled) return;
      setInventory({
        accounts,
        keys: [],
        subscriptions: subscriptionSources(),
        proxySignInAvailable: proxySignInAvailable(),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Object URLs outlive the component unless we revoke them, and the cropper
  // holds one for as long as it is open.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const sources: HarnessBrainSource[] = useMemo(
    () => [...inventory.accounts, ...keySources, ...inventory.subscriptions],
    [inventory.accounts, inventory.subscriptions, keySources],
  );

  const selectedKeyRow: HarnessKeySource | null = useMemo(() => {
    if (draft.source.kind !== "key") return null;
    const source = draft.source as { provider: string; credentialId: string };
    return keySources.find((row) => row.provider === source.provider && row.credentialId === source.credentialId) ?? null;
  }, [draft.source, keySources]);

  const modelChoices = useMemo(
    () => modelChoicesForSource(draft.source, selectedKeyRow),
    [draft.source, selectedKeyRow],
  );
  const freeTextModel = sourceNeedsFreeTextModel(draft.source, selectedKeyRow);

  const errors = validateHarnessPreset(draft);
  // A blank name is only wrong once the person has touched the field: step 3
  // opens on an empty box, and a red sentence under a box nobody typed in yet
  // reads as a scolding, not a hint. Create stays disabled either way.
  const [nameTouched, setNameTouched] = useState(false);
  const canLeaveStep1 = !errors.harness;
  const canLeaveStep2 = !errors.source && !errors.model;
  const canSave = Object.keys(errors).length === 0;

  const patch = useCallback((next: Partial<HarnessPresetDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const chooseHarness = useCallback((harness: HarnessPresetBody) => {
    setDraft((prev) => ({
      ...prev,
      harness,
      permissionMode: coerceHarnessPermissionMode(harness, prev.permissionMode),
      // Advanced only exists for Claude; leaving pins behind on another harness
      // would save settings nothing reads.
      agentOverrides: harness === "claude" ? prev.agentOverrides : {},
      accentColor:
        prev.accentColor === DEFAULT_HARNESS_PRESET_ACCENT
          ? normalizeHex(providerColor(harness))
          : prev.accentColor,
    }));
  }, []);

  const chooseSource = useCallback((row: HarnessBrainSource) => {
    const source = sourceFromInventoryRow(row);
    setDraft((prev) => ({
      ...prev,
      source,
      // A model from the previous provider is meaningless under the new one.
      model: sourceKeepsModel(prev.source, source) ? prev.model : "",
      ...(sourceKeepsModel(prev.source, source) ? {} : { subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT }),
    }));
  }, []);

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

  const handleGenerate = useCallback(async () => {
    const generate = presetsBridge()?.generateLogo;
    if (typeof generate !== "function") return;
    setGenerating(true);
    setLogoError(null);
    try {
      const result = await generate({
        name: draft.name,
        harness: draft.harness,
        accentColor: draft.accentColor,
      });
      if (result?.dataUrl) patch({ logo: { kind: "generated", dataUrl: result.dataUrl } });
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "The logo could not be generated.");
    } finally {
      setGenerating(false);
    }
  }, [draft.accentColor, draft.harness, draft.name, patch]);

  const generateAvailable = typeof presetsBridge()?.generateLogo === "function";

  return (
    // One card, like every other settings page, rather than a header and a
    // grid loose on the background. The gaps are one value (16) everywhere, and
    // the header and footer are separated by hairlines so each step reads as a
    // page with a top and a bottom instead of a stack of floating boxes.
    <div
      data-harness-wizard=""
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 16,
        borderRadius: 12,
        border: `1px solid ${COLORS.borderMuted}`,
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        fontFamily: SANS_FONT,
        minWidth: 0,
      }}
    >
      <WizardHeader
        step={step}
        editing={editingPresetId != null}
        onCancel={onCancel}
      />

      {missing.length > 0 ? (
        <div
          role="status"
          data-harness-wizard-missing=""
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${COLORS.warning}`,
            background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: COLORS.textPrimary,
          }}
        >
          <strong style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
            <Warning size={13} weight="fill" /> This harness needs something this computer does not have yet
          </strong>
          {missing.map((entry) => (
            <span key={entry}>{harnessPresetMissingCopy(entry)}</span>
          ))}
        </div>
      ) : null}

      <BuildPreview draft={draft} step={step} reducedMotion={reducedMotion} />

      {step === 1 ? (
        <StepBody
          selected={draft.harness}
          availability={availability}
          onSelect={chooseHarness}
        />
      ) : null}

      {step === 2 ? (
        <StepBrain
          draft={draft}
          sources={sources}
          modelChoices={modelChoices}
          freeTextModel={freeTextModel}
          freeTextPlaceholder={selectedKeyRow?.baseUrl ? "Model id this endpoint accepts" : "Model id this key can use"}
          proxyAvailable={inventory.proxySignInAvailable}
          onChooseSource={chooseSource}
          onPatch={patch}
        />
      ) : null}

      {step === 3 ? (
        <StepIdentity
          draft={draft}
          generateAvailable={generateAvailable}
          generating={generating}
          logoError={logoError}
          nameError={nameTouched ? errors.name : undefined}
          onNameTouched={() => setNameTouched(true)}
          accentError={errors.accentColor}
          fileInputRef={fileInputRef}
          onPatch={patch}
          onPickFile={handleFile}
          onGenerate={handleGenerate}
        />
      ) : null}

      {cropSrc ? (
        <div
          role="dialog"
          aria-label="Crop the logo"
          style={{
            padding: 16,
            borderRadius: 10,
            border: `1px solid ${COLORS.outlineBorder}`,
            background: COLORS.cardBg,
          }}
        >
          <HarnessLogoCropper
            imageSrc={cropSrc}
            onCancel={() => setCropSrc(null)}
            onConfirm={(dataUrl) => {
              patch({ logo: { kind: "upload", dataUrl } });
              setCropSrc(null);
            }}
          />
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingTop: 14,
          borderTop: `1px solid ${COLORS.borderMuted}`,
        }}
      >
        <button
          type="button"
          style={outlineButton({ opacity: step === 1 ? 0.5 : 1 })}
          disabled={step === 1}
          onClick={() => setStep((current) => (current === 3 ? 2 : 1))}
        >
          <CaretLeft size={12} /> Back
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={outlineButton()} onClick={onCancel}>Cancel</button>
          {step < 3 ? (
            <button
              type="button"
              style={primaryButton()}
              disabled={step === 1 ? !canLeaveStep1 : !canLeaveStep2}
              onClick={() => setStep((current) => (current === 1 ? 2 : 3))}
            >
              Next <CaretRight size={12} />
            </button>
          ) : (
            <button
              type="button"
              style={primaryButton()}
              disabled={!canSave}
              onClick={() => onSave(draft)}
            >
              {editingPresetId ? "Save changes" : "Create"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Keep the chosen model when the source still points at the same provider. */
function sourceKeepsModel(previous: HarnessPresetSource, next: HarnessPresetSource): boolean {
  if (previous.kind === "key" && next.kind === "key") return previous.provider === next.provider;
  const providerOf = (source: HarnessPresetSource) =>
    source.kind === "key" ? source.provider : source.provider;
  return providerOf(previous) === providerOf(next);
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : DEFAULT_HARNESS_PRESET_ACCENT;
}

const STEP_TITLES: Record<Step, { title: string; description: string }> = {
  1: { title: "Pick an agent", description: "The agent ADE runs. You can pick one that is not set up yet." },
  2: { title: "Pick a brain", description: "Where it gets its intelligence, and which model it uses." },
  3: { title: "Name it", description: "What it is called, and how it looks in a list." },
};

function WizardHeader({ step, editing, onCancel }: { step: Step; editing: boolean; onCancel: () => void }) {
  const copy = STEP_TITLES[step];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        paddingBottom: 14,
        borderBottom: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: COLORS.textMuted }}>
            {editing ? "Edit custom" : "New custom"}
          </span>
          {/* Three dots, because there are three steps and a reader should not
              have to parse "Step 2 of 3" to know where they are. */}
          <span aria-hidden style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {([1, 2, 3] as Step[]).map((dot) => (
              <span
                key={dot}
                style={{
                  width: dot === step ? 14 : 5,
                  height: 5,
                  borderRadius: 3,
                  background: dot <= step ? COLORS.accent : COLORS.outlineBorder,
                }}
              />
            ))}
          </span>
          <span style={{ fontSize: 10, color: COLORS.textDim }}>Step {step} of 3</span>
        </div>
        <h3 style={{ margin: "6px 0 2px", fontSize: 15, fontWeight: 650, color: COLORS.textPrimary }}>{copy.title}</h3>
        <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: COLORS.textMuted }}>{copy.description}</p>
      </div>
      <button type="button" style={outlineButton()} onClick={onCancel}>Close</button>
    </div>
  );
}

/**
 * The thing being assembled.
 *
 * The body card is always drawn; the brain card only exists once a source has
 * been chosen, and it arrives with a short snap so the join reads as an
 * assembly rather than as a second field appearing.
 */
function BuildPreview({
  draft,
  step,
  reducedMotion,
}: {
  draft: HarnessPresetDraft;
  step: Step;
  reducedMotion: boolean;
}) {
  const hasBrain = Boolean(draft.model);
  const accent = draft.accentColor;
  const transition = reducedMotion ? "none" : "transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 200ms ease";
  return (
    <div
      data-harness-build-preview=""
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${COLORS.outlineBorder}`,
        background: COLORS.recessedBg,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 10,
          border: `1px solid ${accent}`,
          background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
          transform: reducedMotion || step >= 1 ? "translateX(0)" : "translateX(-12px)",
          transition,
        }}
      >
        <ProviderLogo family={draft.harness} size={20} />
        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
          {harnessBodyLabel(draft.harness)}
        </span>
      </div>

      <span style={{ fontSize: 14, color: COLORS.textMuted }}>+</span>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 10,
          border: `1px solid ${hasBrain ? accent : COLORS.borderMuted}`,
          background: hasBrain ? `color-mix(in srgb, ${accent} 14%, transparent)` : "transparent",
          opacity: hasBrain ? 1 : 0.45,
          transform: hasBrain || reducedMotion ? "translateX(0) scale(1)" : "translateX(14px) scale(0.96)",
          transition,
          minWidth: 0,
        }}
      >
        <HarnessLogo logo={draft.logo} size={18} accentColor={hasBrain ? accent : null} />
        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {hasBrain ? harnessModelLabel(draft.model) : "No model yet"}
        </span>
      </div>
    </div>
  );
}

function StepBody({
  selected,
  availability,
  onSelect,
}: {
  selected: HarnessPresetBody;
  availability: ReturnType<typeof harnessAvailabilityMap>;
  onSelect: (harness: HarnessPresetBody) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Agent"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 8 }}
    >
      {HARNESS_PRESET_BODIES.map((harness) => {
        const isSelected = harness === selected;
        const state = availability[harness];
        const accent = providerColor(harness);
        return (
          <button
            key={harness}
            type="button"
            role="radio"
            aria-checked={isSelected}
            data-harness-card={harness}
            onClick={() => onSelect(harness)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 6,
              padding: 12,
              borderRadius: 10,
              textAlign: "left",
              cursor: "pointer",
              fontFamily: SANS_FONT,
              border: `1px solid ${isSelected ? accent : COLORS.outlineBorder}`,
              background: isSelected ? `color-mix(in srgb, ${accent} 12%, transparent)` : COLORS.cardBg,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
              <ProviderLogo family={harness} size={20} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
                {harnessBodyLabel(harness)}
              </span>
              {isSelected ? <Check size={13} weight="bold" style={{ color: accent }} /> : null}
            </span>
            <span style={{ fontSize: 10.5, lineHeight: 1.45, color: state.available ? COLORS.textMuted : COLORS.warning }}>
              {state.available ? "Ready on this computer" : state.reason}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StepBrain({
  draft,
  sources,
  modelChoices,
  freeTextModel,
  freeTextPlaceholder,
  proxyAvailable,
  onChooseSource,
  onPatch,
}: {
  draft: HarnessPresetDraft;
  sources: HarnessBrainSource[];
  modelChoices: Array<{ id: string; label: string }>;
  freeTextModel: boolean;
  freeTextPlaceholder: string;
  proxyAvailable: boolean;
  onChooseSource: (row: HarnessBrainSource) => void;
  onPatch: (next: Partial<HarnessPresetDraft>) => void;
}) {
  const permissionOptions = harnessPermissionOptions(draft.harness);
  const subagentOptions = useMemo(
    () => [
      { value: HARNESS_PRESET_SUBAGENT_INHERIT, label: "Same as main" },
      ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label })),
    ],
    [modelChoices],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <section aria-label="Source" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>Source</SectionLabel>
        <div role="radiogroup" aria-label="Source" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sources.map((row) => {
            const isSelected = sourceMatchesRow(draft.source, row);
            const key =
              row.kind === "account" ? `account:${row.instanceId}`
                : row.kind === "key" ? `key:${row.provider}:${row.credentialId}`
                  : `subscription:${row.provider}`;
            const accent = row.kind === "account" && row.accentColor ? row.accentColor : providerColor(row.provider);
            return (
              <div
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 11px",
                  borderRadius: 9,
                  border: `1px solid ${isSelected ? accent : COLORS.outlineBorder}`,
                  background: isSelected ? `color-mix(in srgb, ${accent} 10%, transparent)` : COLORS.cardBg,
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  data-harness-source={key}
                  onClick={() => onChooseSource(row)}
                  style={{
                    display: "flex",
                    flex: 1,
                    minWidth: 0,
                    alignItems: "center",
                    gap: 10,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: SANS_FONT,
                  }}
                >
                  <ProviderLogo family={row.provider} size={18} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
                      {harnessSourceRowTitle(row)}
                    </span>
                    <span style={{ display: "block", fontSize: 10.5, color: COLORS.textMuted }}>
                      {harnessSourceRowDetail(row)}
                    </span>
                  </span>
                </button>
                {row.kind === "subscription" ? (
                  <button
                    type="button"
                    data-harness-proxy-sign-in={row.provider}
                    disabled={!proxyAvailable}
                    title={proxyAvailable ? undefined : HARNESS_PROXY_SIGN_IN_UNAVAILABLE}
                    onClick={() => {
                      const signIn = (window as unknown as {
                        ade?: { proxy?: { signIn?: (args: { provider: string }) => Promise<unknown> } };
                      }).ade?.proxy?.signIn;
                      if (typeof signIn === "function") void signIn({ provider: row.provider });
                    }}
                    style={outlineButton({
                      opacity: proxyAvailable ? 1 : 0.55,
                      cursor: proxyAvailable ? "pointer" : "not-allowed",
                    })}
                  >
                    Sign in
                  </button>
                ) : null}
              </div>
            );
          })}
          {sources.length === 0 ? (
            <p style={{ margin: 0, fontSize: 11.5, color: COLORS.textMuted }}>
              No accounts or keys yet. Add one on the AI providers page, then come back.
            </p>
          ) : null}
        </div>
        {!proxyAvailable ? (
          <p style={{ margin: 0, fontSize: 10.5, color: COLORS.textMuted }}>
            {HARNESS_PROXY_SIGN_IN_UNAVAILABLE}
          </p>
        ) : null}
      </section>

      <Row label="Model" htmlFor="harness-model">
        {freeTextModel ? (
          <SettingsTextField
            id="harness-model"
            value={draft.model}
            onChange={(value) => onPatch({ model: value })}
            placeholder={freeTextPlaceholder}
            ariaLabel="Model"
            mono
            fullWidth={false}
          />
        ) : (
          <SettingsSelect
            id="harness-model"
            ariaLabel="Model"
            value={draft.model}
            options={[{ value: "", label: "Choose a model" }, ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label }))]}
            onChange={(value) => onPatch({ model: value })}
          />
        )}
      </Row>

      {draft.model ? (
        <Row label="Effort">
          <ReasoningEffortPicker
            modelId={draft.model}
            reasoningEffort={draft.reasoningEffort ?? null}
            useFamilyDefaults={false}
            onChange={(effort) =>
              onPatch(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined })
            }
          />
        </Row>
      ) : null}

      <Row label="Permission mode">
        <PermissionModePicker
          ariaLabel="Permission mode"
          selectedValue={draft.permissionMode}
          options={permissionOptions}
          onSelect={(value) => onPatch({ permissionMode: value })}
        />
      </Row>

      <Row label="Subagents" htmlFor="harness-subagent-model">
        <SettingsSelect
          id="harness-subagent-model"
          ariaLabel="Subagent model"
          value={draft.subagentModel}
          options={subagentOptions}
          onChange={(value) => onPatch({ subagentModel: value })}
        />
      </Row>

      {draft.harness === "claude" ? (
        <SettingsDisclosure summary="Advanced" gap={12}>
          {HARNESS_PRESET_AGENT_KEYS.map((agent) => {
            const value = draft.agentOverrides[agent] ?? ADVANCED_FOLLOWS;
            const pinned = value !== ADVANCED_FOLLOWS;
            return (
              <div key={agent} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Row label={HARNESS_PRESET_AGENT_LABELS[agent]} htmlFor={`harness-agent-${agent}`}>
                  <SettingsSelect
                    id={`harness-agent-${agent}`}
                    ariaLabel={`${HARNESS_PRESET_AGENT_LABELS[agent]} model`}
                    value={value}
                    options={[
                      { value: ADVANCED_FOLLOWS, label: "Follows subagents" },
                      ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label })),
                    ]}
                    onChange={(next) => {
                      const overrides = { ...draft.agentOverrides };
                      if (next === ADVANCED_FOLLOWS) delete overrides[agent];
                      else overrides[agent] = next;
                      onPatch({ agentOverrides: overrides });
                    }}
                  />
                </Row>
                {pinned ? (
                  <p
                    data-harness-agent-note={agent}
                    style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}
                  >
                    {harnessPresetAgentOverrideNote(agent)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </SettingsDisclosure>
      ) : null}
    </div>
  );
}

function StepIdentity({
  draft,
  generateAvailable,
  generating,
  logoError,
  nameError,
  onNameTouched,
  accentError,
  fileInputRef,
  onPatch,
  onPickFile,
  onGenerate,
}: {
  draft: HarnessPresetDraft;
  generateAvailable: boolean;
  generating: boolean;
  logoError: string | null;
  nameError?: string;
  onNameTouched: () => void;
  accentError?: string;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onPatch: (next: Partial<HarnessPresetDraft>) => void;
  onPickFile: (file: File | null | undefined) => void;
  onGenerate: () => void;
}) {
  const tiles: Array<{ id: HarnessPresetLogo["kind"]; label: string; onSelect: () => void }> = [
    { id: "ade", label: "Default", onSelect: () => onPatch({ logo: { kind: "ade" } }) },
    {
      id: "provider",
      label: "Provider logo",
      onSelect: () => onPatch({ logo: { kind: "provider", providerId: draft.harness } }),
    },
    { id: "upload", label: "Upload", onSelect: () => fileInputRef.current?.click() },
  ];
  if (generateAvailable) {
    tiles.push({ id: "generated", label: generating ? "Generating…" : "Generate", onSelect: onGenerate });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <Row label="Name" htmlFor="harness-name">
        <SettingsTextField
          id="harness-name"
          value={draft.name}
          onChange={(value) => onPatch({ name: value.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH) })}
          onBlur={onNameTouched}
          placeholder="Opus on work"
          ariaLabel="Name"
          fullWidth={false}
        />
      </Row>
      {nameError ? <FieldError>{nameError}</FieldError> : null}

      <Row label="Accent" htmlFor="harness-accent">
        <input
          id="harness-accent"
          type="color"
          aria-label="Accent"
          value={draft.accentColor}
          onChange={(event) => onPatch({ accentColor: event.target.value.toLowerCase() })}
          style={{
            width: 42,
            height: 28,
            padding: 0,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            background: "transparent",
            cursor: "pointer",
          }}
        />
      </Row>
      {accentError ? <FieldError>{accentError}</FieldError> : null}

      <section aria-label="Logo" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel>Logo</SectionLabel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tiles.map((tile) => {
            const isSelected = draft.logo.kind === tile.id;
            return (
              <button
                key={tile.id}
                type="button"
                data-harness-logo-tile={tile.id}
                aria-pressed={isSelected}
                onClick={tile.onSelect}
                disabled={tile.id === "generated" && generating}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  width: 96,
                  padding: 10,
                  borderRadius: 10,
                  cursor: "pointer",
                  fontFamily: SANS_FONT,
                  fontSize: 10.5,
                  color: COLORS.textPrimary,
                  border: `1px solid ${isSelected ? draft.accentColor : COLORS.outlineBorder}`,
                  background: isSelected ? `color-mix(in srgb, ${draft.accentColor} 12%, transparent)` : COLORS.cardBg,
                }}
              >
                {tile.id === "upload" ? (
                  <UploadSimple size={20} />
                ) : (
                  <HarnessLogo
                    logo={
                      tile.id === "provider"
                        ? { kind: "provider", providerId: draft.harness }
                        : tile.id === "generated" && draft.logo.kind === "generated"
                          ? draft.logo
                          : { kind: "ade" }
                    }
                    size={20}
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
            onPickFile(event.target.files?.[0]);
            // Reset so picking the same file twice still fires a change.
            event.target.value = "";
          }}
        />
        {logoError ? <FieldError>{logoError}</FieldError> : null}
      </section>

      <section aria-label="Preview" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>Preview</SectionLabel>
        <span
          data-harness-preview-chip=""
          style={{
            display: "inline-flex",
            alignSelf: "flex-start",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 999,
            border: `1px solid ${draft.accentColor}`,
            background: `color-mix(in srgb, ${draft.accentColor} 12%, transparent)`,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textPrimary,
          }}
        >
          <HarnessLogo logo={draft.logo} size={18} accentColor={draft.accentColor} />
          {draft.name.trim() || harnessBodyLabel(draft.harness)}
          <span style={{ fontWeight: 400, color: COLORS.textMuted }}>
            {harnessBodyLabel(draft.harness)} · {draft.model ? harnessModelLabel(draft.model) : "no model"}
          </span>
        </span>
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: COLORS.textMuted }}>
      {children}
    </span>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" style={{ margin: 0, fontSize: 10.5, color: COLORS.danger }}>{children}</p>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}
