import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, Check, Warning } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../../shared/types";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_BODIES,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  harnessBodyLabel,
  harnessPresetMissingCopy,
  validateHarnessPreset,
  type HarnessPresetBody,
  type HarnessPresetDraft,
  type HarnessPresetMissing,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { providerColor } from "../../usage/providerColors";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { harnessAvailabilityMap } from "./harnessAvailability";
import {
  harnessModelLabel,
  modelChoicesForSource,
  providerFamilyForSource,
  sourceNeedsFreeTextModel,
} from "./harnessModels";
import { useRuntimeCatalogForFamily } from "../../shared/ModelPicker/useRuntimeCatalogForFamily";
import {
  EMPTY_HARNESS_SOURCE_INVENTORY,
  loadHarnessAccounts,
  proxySignInAvailable,
  readStoredKeySources,
  sourceFromInventoryRow,
  subscriptionSources,
  type HarnessKeySource,
  type HarnessModelSource,
  type HarnessSourceInventory,
} from "./harnessSources";
import { HarnessLogoCropper } from "./HarnessLogoCropper";
import { StepModel } from "./HarnessWizardStepModel";
import { StepIdentity } from "./HarnessWizardStepIdentity";

/**
 * Building a custom provider: pick the harness, pick the model provider and
 * model, name it.
 *
 * Three steps because there are exactly three decisions, and separating them is
 * what lets the middle step show a model list that already knows which provider
 * it is listing. The build animation is the point of the shape: the harness
 * card slides in, and the model card snaps onto it in the preset's accent, so
 * the thing you are assembling is visible the whole way through rather than
 * being a form you fill in and a row that appears afterwards.
 *
 * A permission tier is deliberately NOT part of a custom provider. It belongs
 * to the harness and is chosen at launch in the composer, the same as for every
 * built-in provider; storing a second copy here would let the composer and the
 * custom provider disagree about the same run.
 *
 * Unavailable harnesses stay selectable on purpose — see `harnessAvailability`.
 * A sign-in the host cannot perform is shown as a disabled button with the
 * reason on it; the wizard never fakes one.
 */

type Step = 1 | 2 | 3;

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

  // Two groups, not one list: an account or a key is something this computer
  // already holds, and a proxy subscription is a sign-in ADE holds elsewhere.
  // The old flat list put a row with a Sign in button beside rows without one
  // and left the reader to work out why.
  const ownedSources: HarnessModelSource[] = useMemo(
    () => [...inventory.accounts, ...keySources],
    [inventory.accounts, keySources],
  );
  const proxySources: HarnessModelSource[] = inventory.subscriptions;

  const selectedKeyRow: HarnessKeySource | null = useMemo(() => {
    if (draft.source.kind !== "key") return null;
    const source = draft.source as { provider: string; credentialId: string };
    return keySources.find((row) => row.provider === source.provider && row.credentialId === source.credentialId) ?? null;
  }, [draft.source, keySources]);

  // The live catalog is the same one the composer's model picker reads, through
  // the same shared cache, and it is only asked for while step 2 is showing.
  const sourceFamily = useMemo(() => providerFamilyForSource(draft.source), [draft.source]);
  const { catalog: runtimeCatalog, loading: catalogLoading } = useRuntimeCatalogForFamily(
    step === 2,
    sourceFamily,
    // A preset is only selectable for a chat — the composer hides the Custom
    // tab in CLI mode — so this enumerates Cursor's chat-capable models, the
    // same source the composer's picker asks for.
    undefined,
    "sdk",
  );
  const modelChoices = useMemo(
    () => modelChoicesForSource(draft.source, selectedKeyRow, runtimeCatalog),
    [draft.source, runtimeCatalog, selectedKeyRow],
  );
  // A custom endpoint needs the text box whatever the catalog says, so it gets
  // it immediately. Every other source waits for the catalog to settle: a
  // provider whose models are still arriving must not flash a text box and
  // then replace it with a select, and the reverse flash is just as bad.
  const endpointNeedsTypedId = Boolean(selectedKeyRow?.baseUrl) && !selectedKeyRow?.models?.length;
  const freeTextModel = endpointNeedsTypedId
    || (!catalogLoading && sourceNeedsFreeTextModel(draft.source, selectedKeyRow, runtimeCatalog));

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
      // Advanced only exists for Claude; leaving pins behind on another harness
      // would save settings nothing reads.
      agentOverrides: harness === "claude" ? prev.agentOverrides : {},
      accentColor:
        prev.accentColor === DEFAULT_HARNESS_PRESET_ACCENT
          ? normalizeHex(providerColor(harness))
          : prev.accentColor,
    }));
  }, []);

  const chooseSource = useCallback((row: HarnessModelSource) => {
    const source = sourceFromInventoryRow(row);
    setDraft((prev) => {
      // A model from the previous provider is meaningless under the new one,
      // and so is a subagent model picked from the same list.
      const keepsModel = sourceKeepsModel(prev.source, source);
      return {
        ...prev,
        source,
        model: keepsModel ? prev.model : "",
        subagentModel: keepsModel ? prev.subagentModel : HARNESS_PRESET_SUBAGENT_INHERIT,
      };
    });
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
        <StepHarness
          selected={draft.harness}
          availability={availability}
          onSelect={chooseHarness}
        />
      ) : null}

      {step === 2 ? (
        <StepModel
          draft={draft}
          ownedSources={ownedSources}
          proxySources={proxySources}
          modelChoices={modelChoices}
          modelsLoading={catalogLoading}
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

/**
 * Keep the chosen model when the source still points at the same provider.
 *
 * The kind of source does not matter: an account, a stored key and a proxy
 * subscription all name a provider, and a model belongs to the provider rather
 * than to the identity paying for it. Swapping a Claude account for the Claude
 * subscription keeps the model; swapping Claude for Cursor cannot. An account
 * and a key never match here, because the two vocabularies spell the same
 * provider differently — `claude` against `anthropic`.
 */
function sourceKeepsModel(previous: HarnessPresetSource, next: HarnessPresetSource): boolean {
  return previous.provider === next.provider;
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : DEFAULT_HARNESS_PRESET_ACCENT;
}

const STEP_TITLES: Record<Step, { title: string; description: string }> = {
  1: {
    title: "Pick a harness",
    description: "Your custom provider starts with the harness that runs it. Next you pick its model.",
  },
  2: {
    title: "Pick a model provider",
    description: "Choose the account or key that pays for it, then the model.",
  },
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
 * The harness card is always drawn; the model card only exists once a model has
 * been chosen, and it arrives with a short snap so the join reads as an
 * assembly rather than as a second field appearing.
 *
 * Each pill carries its own noun. Two bare names side by side made the reader
 * guess which one was the harness and which one was the model, and the empty
 * state said "No model yet" without ever saying what the filled state would be.
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
  const hasModel = Boolean(draft.model);
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
          <span style={{ fontWeight: 400, color: COLORS.textMuted }}>Harness · </span>
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
          border: `1px solid ${hasModel ? accent : COLORS.borderMuted}`,
          background: hasModel ? `color-mix(in srgb, ${accent} 14%, transparent)` : "transparent",
          opacity: hasModel ? 1 : 0.45,
          transform: hasModel || reducedMotion ? "translateX(0) scale(1)" : "translateX(14px) scale(0.96)",
          transition,
          minWidth: 0,
        }}
      >
        <HarnessLogo logo={draft.logo} size={18} accentColor={hasModel ? accent : null} />
        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ fontWeight: 400, color: COLORS.textMuted }}>Model · </span>
          {hasModel ? harnessModelLabel(draft.model) : "not picked yet"}
        </span>
      </div>
    </div>
  );
}

function StepHarness({
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
      aria-label="Harness"
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
