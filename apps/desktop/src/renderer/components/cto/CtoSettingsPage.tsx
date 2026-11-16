/**
 * The CTO's settings: a rail of five topics, one pane at a time.
 *
 *   Look          the avatar (live preview + state strip), name, shape, colour,
 *                 eyes, energy, personality. Saves as you go.
 *   Brain         main model, reasoning and Fast; up to three backup models;
 *                 Refresh context; the home machine and cross-machine reach.
 *   Memory        project notes, notes about the person, open work.
 *   Routines      everything the CTO has scheduled on its chat.
 *   Instructions  standing instructions, and the whole prompt (folded).
 *
 * Props (`CtoSettingsPageProps`), all from `CtoPage`:
 *   pin                     the CTO home machine's binding. Every read and
 *                           write on this page goes there. Null = unreachable.
 *   identity                the CTO identity (null until the snapshot lands).
 *   sessionId               the CTO chat, for Routines and Refresh context.
 *   currentModelId / currentReasoningEffort / currentFastMode
 *                           what the CTO thread runs on now.
 *   availableModelIds / loadingModels   from `useCtoModelOptions(pin)`.
 *   switchingModel          a model switch is in flight.
 *   onModelChange(modelId, effort)       switch the main model (the page
 *                           writes `modelPreferences` and moves the thread).
 *   onFastModeChange?(on)   toggle Fast on the thread.
 *   onOpenProviderSettings  jump to Settings › AI › Providers.
 *   onIdentityChange(patch) => Promise   `cto.updateIdentity({ patch }, pin)`
 *                           and adopt the returned identity. Must reject on
 *                           failure so this page can say "Couldn't save".
 *   crossMachineAvailable?  the home's runtime can reach other machines.
 *   home?                   `{ machineName, onChange }` when the account has
 *                           more than one machine; omitted otherwise.
 *   initialSection?         open on this topic (e.g. "memory" for "See all").
 *   onBack                  close settings.
 *   active?                 the CTO tab is on screen (gates the sidebar portal).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowsClockwise,
  ArrowUp,
  Brain,
  Notebook,
  Scroll,
  X,
} from "@phosphor-icons/react";
import {
  CTO_AVATAR_EYES,
  CTO_AVATAR_SHAPES,
  CTO_MAX_FALLBACK_MODELS,
  CTO_PERSONALITIES,
  type CtoAvatarEyes,
  type CtoAvatarLook,
  type CtoAvatarShape,
  type CtoAvatarState,
  type CtoIdentity,
  type CtoModelPreferences,
  type CtoPersonality,
  type OpenProjectBinding,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import {
  ModernPage,
  ModernRow,
  ModernRows,
  ModernSection,
  SavedFlash,
  SettingsSegmented,
  SettingsToggle,
  useSavedFlash,
} from "../settings/primitives";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { CtoAccountPicker, ctoAccountProviderFor } from "./CtoAccountPicker";
import { ProjectSidebarSlot, useHasProjectSidebar } from "../app/projectSidebar/ProjectSidebarSlot";
import { useFastModeEnabled } from "../../lib/fastModePolicy";
import { ipcErrorMessage } from "../../lib/format";
import { cn } from "../ui/cn";
import { CtoAvatar, CTO_AVATAR_BLIP_MS } from "./avatar/CtoAvatar";
import { CTO_AVATAR_SWATCHES, normalizeHexColor, resolveCtoAvatarLook } from "./avatar/ctoAvatarLook";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { CtoRoutineRows } from "./CtoRoutineRows";
import { AutosaveTextArea, CTO_SETTINGS_GROUP } from "./ctoSettingsUi";
import {
  CTO_ELIGIBLE_PROVIDERS_COPY,
  ctoModelSupportsLiveRedirect,
  toCtoModelPreferences,
} from "./useCtoModelOptions";

export type CtoSettingsSection = "look" | "brain" | "memory" | "routines" | "instructions";

/** The identity fields this page writes. */
export type CtoIdentityPatch = Partial<Pick<
  CtoIdentity,
  "name" | "systemPromptExtension" | "crossMachineEnabled" | "avatar" | "personality" | "fallbackModels"
>>;

export type CtoSettingsPageProps = {
  active?: boolean;
  pin: OpenProjectBinding | null;
  identity: CtoIdentity | null;
  sessionId: string | null;
  currentModelId: string;
  currentReasoningEffort: string | null;
  currentFastMode: boolean;
  availableModelIds: string[];
  loadingModels: boolean;
  switchingModel: boolean;
  onModelChange: (modelId: string, reasoningEffort: string | null) => void | Promise<void>;
  /** Which signed-in account runs the main model; null is the provider's default. */
  onAccountChange?: (instanceId: string | null) => void | Promise<void>;
  onFastModeChange?: (enabled: boolean) => void | Promise<void>;
  onOpenProviderSettings: () => void;
  onIdentityChange: (patch: CtoIdentityPatch) => Promise<void>;
  crossMachineAvailable?: boolean;
  home?: { machineName: string; onChange: () => void } | null;
  initialSection?: CtoSettingsSection;
  onBack: () => void;
};

const SHAPE_LABELS: Record<CtoAvatarShape, string> = {
  pebble: "Pebble", bean: "Bean", spark: "Spark", chip: "Chip", drop: "Drop", cloud: "Cloud", hex: "Hex",
};
const EYE_LABELS: Record<CtoAvatarEyes, string> = {
  caret: "Caret", round: "Round", visor: "Visor", pixel: "Pixel",
};
const PERSONALITY_COPY: Record<CtoPersonality, { title: string; example: string }> = {
  focused: {
    title: "Focused",
    example: "Fixed. A race in the login test; fix is on auth-fix.",
  },
  friendly: {
    title: "Friendly",
    example: "Good news: the login flake was a race. The fix is ready.",
  },
  playful: {
    title: "Playful",
    example: "Caught it! A sneaky race in the login test. Fix is up.",
  },
};
const PREVIEW_STATES: ReadonlyArray<{ state: CtoAvatarState; label: string }> = [
  { state: "idle", label: "Idle" },
  { state: "working", label: "Working" },
  { state: "thinking", label: "Thinking" },
  { state: "waiting", label: "Waiting" },
  { state: "asleep", label: "Asleep" },
  { state: "happy", label: "Happy" },
  { state: "error", label: "Error" },
];
const LOOK_SAVE_DELAY_MS = 450;

/* ── Look ── */

/**
 * Patches queued from several controls, sent together once the person stops
 * for a moment. `pending` is true while anything is queued or in flight, so
 * an identity echo cannot overwrite a choice that has not landed yet.
 */
function useQueuedIdentitySave(onIdentityChange: CtoSettingsPageProps["onIdentityChange"]) {
  const queuedRef = useRef<CtoIdentityPatch>({});
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const { state, flash, fail } = useSavedFlash();

  const flush = useCallback(async () => {
    timerRef.current = null;
    if (inFlightRef.current) {
      timerRef.current = window.setTimeout(() => void flush(), LOOK_SAVE_DELAY_MS);
      return;
    }
    const patch = queuedRef.current;
    queuedRef.current = {};
    if (Object.keys(patch).length === 0) return;
    inFlightRef.current = true;
    try {
      await onIdentityChange(patch);
      flash();
    } catch (err) {
      fail(ipcErrorMessage(err) || "Couldn't save.");
    } finally {
      inFlightRef.current = false;
    }
  }, [fail, flash, onIdentityChange]);

  const queue = useCallback((patch: CtoIdentityPatch) => {
    queuedRef.current = { ...queuedRef.current, ...patch };
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), LOOK_SAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => () => {
    // Leaving the pane sends what is queued rather than dropping it.
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      void flush();
    }
  }, [flush]);

  const isPending = () => timerRef.current != null || inFlightRef.current;
  return { queue, state, isPending };
}

function LookTile({
  active,
  label,
  onSelect,
  children,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ade-ap-choice"
      data-active={active ? "true" : undefined}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="flex items-center justify-center pb-1 pt-3">{children}</span>
      <span className="pb-2.5 text-center text-[11.5px] font-medium text-[var(--kit-text-2)]">{label}</span>
    </button>
  );
}

const TILE_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))",
  gap: 8,
  marginTop: 10,
};

function LookPane({
  identity,
  onIdentityChange,
}: {
  identity: CtoIdentity | null;
  onIdentityChange: CtoSettingsPageProps["onIdentityChange"];
}) {
  const { queue, state: saveState, isPending } = useQueuedIdentitySave(onIdentityChange);
  const [look, setLook] = useState<CtoAvatarLook>(() => resolveCtoAvatarLook(identity?.avatar));
  const [name, setName] = useState(identity?.name ?? "");
  const [personality, setPersonality] = useState<CtoPersonality>(identity?.personality ?? "focused");
  const isSwatch = CTO_AVATAR_SWATCHES.some((swatch) => swatch.color === look.color);
  const [hexDraft, setHexDraft] = useState(isSwatch ? "" : look.color);
  const [preview, setPreview] = useState<{ state: CtoAvatarState; key: number }>({ state: "idle", key: 0 });

  // Follow the stored identity (another device, the CTO itself) unless a
  // change made here has not landed yet.
  const avatarKey = JSON.stringify(identity?.avatar ?? null);
  useEffect(() => {
    if (isPending()) return;
    const next = resolveCtoAvatarLook(identity?.avatar);
    setLook(next);
    setPersonality(identity?.personality ?? "focused");
    setName((current) => (document.activeElement?.id === "cto-name" ? current : identity?.name ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the identity's values
  }, [avatarKey, identity?.personality, identity?.name]);

  // The two once-only states hand back to idle after they play.
  useEffect(() => {
    if (preview.state !== "happy" && preview.state !== "error") return undefined;
    const timer = window.setTimeout(() => setPreview((current) => ({ ...current, state: "idle" })), CTO_AVATAR_BLIP_MS);
    return () => window.clearTimeout(timer);
  }, [preview]);

  const changeLook = (patch: Partial<CtoAvatarLook>) => {
    const next = { ...look, ...patch };
    setLook(next);
    queue({ avatar: next });
  };

  const displayName = name.trim() || "CTO";

  return (
    <ModernPage>
      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.look"
        title="Look"
        actions={<SavedFlash state={saveState} />}
      >
        <div
          className="flex flex-col items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--kit-panel-edge)] px-4 pb-4 pt-8"
          style={{
            background: `radial-gradient(ellipse 60% 70% at 50% 62%, color-mix(in srgb, ${look.color} 13%, transparent), transparent 70%), var(--kit-panel-bg)`,
          }}
        >
          <CtoAvatar
            key={preview.key}
            look={look}
            state={preview.state}
            size={132}
            motion="live"
            title={`${displayName}, ${preview.state}`}
          />
          <div className="max-w-full truncate text-[15px] font-semibold text-fg">{displayName}</div>
          <div className="kit-seg max-w-full overflow-x-auto" data-case="sentence" role="group" aria-label="Play a state">
            {PREVIEW_STATES.map((entry) => (
              <button
                key={entry.state}
                type="button"
                aria-pressed={preview.state === entry.state}
                onClick={() => setPreview((current) => ({ state: entry.state, key: current.key + 1 }))}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <ModernRows>
          <ModernRow
            title="Name"
            control={
              <input
                id="cto-name"
                className="kit-input"
                style={{ width: 200 }}
                value={name}
                placeholder="CTO"
                aria-label="Name"
                maxLength={40}
                onChange={(event) => {
                  setName(event.target.value);
                  const trimmed = event.target.value.trim();
                  if (trimmed) queue({ name: trimmed });
                }}
              />
            }
          />
          <ModernRow title="Shape">
            <div style={TILE_GRID} role="group" aria-label="Shape">
              {CTO_AVATAR_SHAPES.map((shape) => (
                <LookTile key={shape} active={look.shape === shape} label={SHAPE_LABELS[shape]} onSelect={() => changeLook({ shape })}>
                  <CtoAvatar look={{ ...look, shape }} state="idle" size={44} motion="static" />
                </LookTile>
              ))}
            </div>
          </ModernRow>
          <ModernRow title="Colour">
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5" role="group" aria-label="Colour">
              {CTO_AVATAR_SWATCHES.map((swatch) => {
                const selected = swatch.color === look.color;
                return (
                  <button
                    key={swatch.color}
                    type="button"
                    title={swatch.name}
                    aria-label={swatch.name}
                    aria-pressed={selected}
                    onClick={() => {
                      setHexDraft("");
                      changeLook({ color: swatch.color });
                    }}
                    className="h-[26px] w-[26px] rounded-full transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/60 motion-reduce:transition-none motion-reduce:hover:scale-100"
                    style={{
                      background: swatch.color,
                      boxShadow: selected ? `0 0 0 2px var(--color-bg), 0 0 0 4px ${swatch.color}` : undefined,
                    }}
                  />
                );
              })}
              <input
                className="kit-input kit-num ml-1"
                data-size="sm"
                style={{ width: 92 }}
                value={hexDraft}
                placeholder="#hex"
                aria-label="Custom colour (hex)"
                aria-invalid={hexDraft.trim() && !normalizeHexColor(hexDraft) ? true : undefined}
                spellCheck={false}
                onChange={(event) => {
                  setHexDraft(event.target.value);
                  const color = normalizeHexColor(event.target.value);
                  if (color) changeLook({ color });
                }}
              />
            </div>
          </ModernRow>
          <ModernRow title="Eyes">
            <div style={TILE_GRID} role="group" aria-label="Eyes">
              {CTO_AVATAR_EYES.map((eyes) => (
                <LookTile key={eyes} active={look.eyes === eyes} label={EYE_LABELS[eyes]} onSelect={() => changeLook({ eyes })}>
                  <CtoAvatar look={{ ...look, eyes }} state="idle" size={44} motion="static" />
                </LookTile>
              ))}
            </div>
          </ModernRow>
          <ModernRow
            title="Energy"
            hint="How much it moves"
            control={
              <SettingsSegmented
                ariaLabel="Energy"
                value={look.energy}
                options={[{ value: "calm", label: "Calm" }, { value: "lively", label: "Lively" }]}
                onChange={(energy) => {
                  changeLook({ energy });
                  setPreview((current) => ({ state: "working", key: current.key + 1 }));
                }}
              />
            }
          />
        </ModernRows>
      </ModernSection>

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.personality"
        title="Personality"
        hint={`How ${displayName} talks`}
      >
        <div className="ade-modern-choices" role="radiogroup" aria-label="Personality">
          {CTO_PERSONALITIES.map((value) => {
            const copy = PERSONALITY_COPY[value];
            const selected = personality === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                className="ade-ap-choice"
                data-active={selected ? "true" : undefined}
                onClick={() => {
                  setPersonality(value);
                  queue({ personality: value });
                }}
              >
                <span className="ade-modern-choice-body">
                  <span className="ade-modern-choice-title">{copy.title}</span>
                  <span className="ade-modern-choice-hint">“{copy.example}”</span>
                </span>
              </button>
            );
          })}
        </div>
      </ModernSection>
    </ModernPage>
  );
}

/* ── Brain ── */

function modelName(modelId: string | undefined): string {
  if (!modelId) return "this model";
  return getModelById(modelId)?.displayName ?? modelId;
}

function BrainPane(props: CtoSettingsPageProps & { name: string }) {
  const {
    pin,
    identity,
    sessionId,
    currentModelId,
    currentReasoningEffort,
    currentFastMode,
    availableModelIds,
    loadingModels,
    switchingModel,
    onModelChange,
    onAccountChange,
    onFastModeChange,
    onOpenProviderSettings,
    onIdentityChange,
    crossMachineAvailable = false,
    home,
    name,
  } = props;
  const fastModeAllowed = useFastModeEnabled();
  const [fallbacks, setFallbacks] = useState<CtoModelPreferences[]>(identity?.fallbackModels ?? []);
  const fallbackKey = JSON.stringify(identity?.fallbackModels ?? []);
  const fallbackSave = useSavedFlash();
  const [refresh, setRefresh] = useState<{ kind: "idle" | "busy" | "done" | "error"; message?: string }>({ kind: "idle" });

  useEffect(() => {
    setFallbacks(identity?.fallbackModels ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored list's value
  }, [fallbackKey]);

  const saveFallbacks = async (next: CtoModelPreferences[]) => {
    const previous = fallbacks;
    setFallbacks(next);
    try {
      await onIdentityChange({ fallbackModels: next });
      fallbackSave.flash();
    } catch (err) {
      setFallbacks(previous);
      fallbackSave.fail(ipcErrorMessage(err) || "Couldn't save the backup models.");
    }
  };

  // The main model is the person's pick (the identity preference), not the
  // thread's: after a limit the thread can be on a backup for now.
  const mainModelId = identity?.modelPreferences?.modelId ?? currentModelId;
  const mainReasoningEffort = identity?.modelPreferences
    ? identity.modelPreferences.reasoningEffort ?? null
    : currentReasoningEffort;
  const runningOnBackup = Boolean(currentModelId && mainModelId && currentModelId !== mainModelId);

  const usedIds = new Set([mainModelId, ...fallbacks.map((entry) => entry.modelId ?? "")]);
  // A model on a multi-account provider stays listed: the same model on
  // another account is a real backup (its own limits).
  const backupFilter = (exceptId?: string) => (descriptor: Parameters<typeof ctoModelSupportsLiveRedirect>[0]) =>
    ctoModelSupportsLiveRedirect(descriptor)
    && (descriptor.id === exceptId || !usedIds.has(descriptor.id) || ctoAccountProviderFor(descriptor.id) != null);

  const choiceKey = (entry: { modelId?: string; instanceId?: string | null }) => `${entry.modelId ?? ""}@${entry.instanceId ?? ""}`;
  const mainChoice = { modelId: mainModelId, instanceId: identity?.modelPreferences?.instanceId ?? null };

  /**
   * A backup for a model already in the list goes on an account not used for
   * it yet; with none left, nothing is added.
   */
  const addBackup = async (modelId: string) => {
    const preference = toCtoModelPreferences(modelId);
    if (!preference) return;
    const taken = new Set([choiceKey(mainChoice), ...fallbacks.map(choiceKey)]);
    if (!taken.has(choiceKey(preference))) {
      await saveFallbacks([...fallbacks, preference]);
      return;
    }
    const provider = ctoAccountProviderFor(modelId);
    const accounts = provider && window.ade?.providerInstances?.list
      ? (await window.ade.providerInstances.list({ provider }, pin ?? null).catch(() => []))
        .filter((row) => row.signedIn && !row.sameLoginAs)
      : [];
    const free = accounts.find((account) => !taken.has(choiceKey({ modelId, instanceId: account.isDefault ? null : account.id })));
    if (!free) {
      fallbackSave.fail(`Already a backup on every account`);
      return;
    }
    await saveFallbacks([...fallbacks, { ...preference, ...(free.isDefault ? {} : { instanceId: free.id }) }]);
  };

  const setBackupAccount = (index: number, instanceId: string | null) => {
    void saveFallbacks(fallbacks.map((current, i) => {
      if (i !== index) return current;
      const { instanceId: _previous, ...rest } = current;
      return instanceId ? { ...rest, instanceId } : rest;
    }));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= fallbacks.length) return;
    const next = [...fallbacks];
    [next[index], next[target]] = [next[target]!, next[index]!];
    void saveFallbacks(next);
  };

  const runRefresh = async () => {
    if (!pin || !window.ade?.cto) return;
    setRefresh({ kind: "busy" });
    try {
      const result = await window.ade.cto.refreshContext(pin);
      if (result && result.refreshed === false) {
        setRefresh({ kind: "error", message: result.reason || "Not refreshed" });
        return;
      }
      setRefresh({ kind: "done" });
    } catch (err) {
      setRefresh({ kind: "error", message: ipcErrorMessage(err) || "Couldn't refresh" });
    }
  };

  const crossMachineEnabled = identity?.crossMachineEnabled !== false;

  return (
    <ModernPage>
      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.brain.model"
        title="Model"
      >
        <ModernRows>
          <ModernRow
            title="Main model"
            hint={
              loadingModels
                ? "Checking sign-ins…"
                : availableModelIds.length === 0
                  ? (
                    <button type="button" className="kit-btn" data-size="xs" onClick={onOpenProviderSettings}>
                      Sign in to a provider
                    </button>
                  )
                  : switchingModel
                    ? "Switching…"
                    : runningOnBackup
                      ? (
                        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                          <span className="truncate" title={`On ${modelName(currentModelId)} until ${modelName(mainModelId)} is back`}>
                            On {modelName(currentModelId)} for now
                          </span>
                          <button
                            type="button"
                            className="kit-btn shrink-0"
                            data-size="xs"
                            onClick={() => void onModelChange(mainModelId, mainReasoningEffort)}
                          >
                            Switch back
                          </button>
                        </span>
                      )
                      : null
            }
            control={
              // Only models that take a message mid-turn are listed; the
              // tooltip says which, for the person whose favourite is missing.
              <span className="flex items-center gap-2" title={`${name} runs on ${CTO_ELIGIBLE_PROVIDERS_COPY}`}>
                <ModelPicker
                  value={mainModelId}
                  availableModelIds={availableModelIds}
                  filter={ctoModelSupportsLiveRedirect}
                  disabled={switchingModel}
                  runtimePin={pin}
                  fastMode={fastModeAllowed ? currentFastMode : false}
                  onFastModeChange={fastModeAllowed && onFastModeChange ? (next) => void onFastModeChange(next) : undefined}
                  fastModeAllowed={fastModeAllowed}
                  onChange={(modelId) => void onModelChange(modelId, mainReasoningEffort)}
                  onOpenSignIn={onOpenProviderSettings}
                />
                {mainModelId ? (
                  <ReasoningEffortPicker
                    modelId={mainModelId}
                    reasoningEffort={mainReasoningEffort}
                    disabled={switchingModel}
                    onChange={(effort) => void onModelChange(mainModelId, effort)}
                  />
                ) : null}
                {onAccountChange ? (
                  <CtoAccountPicker
                    modelId={mainModelId}
                    value={identity?.modelPreferences?.instanceId ?? null}
                    pin={pin}
                    disabled={switchingModel}
                    onChange={(instanceId) => void onAccountChange(instanceId)}
                  />
                ) : null}
              </span>
            }
          />
        </ModernRows>
      </ModernSection>

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.brain.fallbacks"
        title="Backup models"
        hint="Used in order when limits hit"
        actions={<SavedFlash state={fallbackSave.state} />}
      >
        <ModernRows>
          {fallbacks.map((entry, index) => (
            <ModernRow
              key={`${entry.modelId ?? entry.model}-${index}`}
              leading={
                <span className="kit-num flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--kit-hover)] text-[11px] text-[var(--kit-text-2)]">
                  {index + 1}
                </span>
              }
              title={
                <ModelPicker
                  value={entry.modelId ?? ""}
                  availableModelIds={availableModelIds}
                  filter={backupFilter(entry.modelId)}
                  runtimePin={pin}
                  onChange={(modelId) => {
                    const preference = toCtoModelPreferences(modelId);
                    if (!preference) return;
                    // Same provider keeps the row's account; another provider has none.
                    const keep = entry.instanceId && ctoAccountProviderFor(modelId) === ctoAccountProviderFor(entry.modelId)
                      ? { instanceId: entry.instanceId }
                      : {};
                    void saveFallbacks(fallbacks.map((current, i) => (i === index ? { ...preference, ...keep } : current)));
                  }}
                  onOpenSignIn={onOpenProviderSettings}
                />
              }
              control={
                <>
                  <CtoAccountPicker
                    modelId={entry.modelId}
                    value={entry.instanceId ?? null}
                    pin={pin}
                    onChange={(instanceId) => setBackupAccount(index, instanceId)}
                  />
                  <button
                    type="button"
                    className="kit-icon-btn"
                    title="Move up"
                    aria-label={`Move ${modelName(entry.modelId)} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="kit-icon-btn"
                    title="Move down"
                    aria-label={`Move ${modelName(entry.modelId)} down`}
                    disabled={index === fallbacks.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="kit-icon-btn"
                    title="Remove"
                    aria-label={`Remove ${modelName(entry.modelId)}`}
                    onClick={() => void saveFallbacks(fallbacks.filter((_, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                </>
              }
            />
          ))}
          {fallbacks.length < CTO_MAX_FALLBACK_MODELS ? (
            <ModernRow
              title={
                <ModelPicker
                  value=""
                  emptyLabel={fallbacks.length === 0 ? "Add a backup" : "Add another"}
                  availableModelIds={availableModelIds}
                  filter={backupFilter()}
                  runtimePin={pin}
                  disabled={loadingModels}
                  onChange={(modelId) => void addBackup(modelId)}
                  onOpenSignIn={onOpenProviderSettings}
                />
              }
            />
          ) : null}
        </ModernRows>
      </ModernSection>

      <ModernSection group={CTO_SETTINGS_GROUP} anchor="cto.brain.context" title="Context">
        <ModernRows>
          <ModernRow
            title="Refresh context"
            hint={
              refresh.kind === "error"
                ? <span className="block truncate" style={{ color: "var(--kit-crit)" }} title={refresh.message}>{refresh.message}</span>
                : <span title="Notes, open work and the last 40 messages carry over">Keeps notes and recent messages</span>
            }
            control={
              <>
                {refresh.kind === "done" ? <span role="status" className="text-[11px] text-[var(--kit-ok)]">Refreshed</span> : null}
                <button
                  type="button"
                  className="kit-btn"
                  data-size="sm"
                  disabled={!pin || !sessionId || refresh.kind === "busy"}
                  onClick={() => void runRefresh()}
                >
                  <ArrowsClockwise size={12} />
                  {refresh.kind === "busy" ? "Refreshing…" : "Refresh"}
                </button>
              </>
            }
          />
          {home ? (
            <ModernRow
              title="Home machine"
              hint={<span className="block truncate" title={home.machineName}>{home.machineName}</span>}
              control={
                <button type="button" className="kit-btn" data-size="sm" onClick={home.onChange}>
                  Change
                </button>
              }
            />
          ) : null}
          {crossMachineAvailable ? (
            <ModernRow
              title="Reach my other machines"
              hint={<span title={`${name} can list, inspect and start work on your other signed-in machines`}>Their permissions still apply</span>}
              control={
                <SettingsToggle
                  label={`Let ${name} reach my other machines`}
                  checked={crossMachineEnabled}
                  onChange={(next) => void onIdentityChange({ crossMachineEnabled: next }).catch(() => {})}
                />
              }
            />
          ) : null}
        </ModernRows>
      </ModernSection>
    </ModernPage>
  );
}

/* ── Instructions ── */

function InstructionsPane({
  pin,
  identity,
  onIdentityChange,
}: {
  pin: OpenProjectBinding | null;
  identity: CtoIdentity | null;
  onIdentityChange: CtoSettingsPageProps["onIdentityChange"];
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const saveInstructions = useCallback(
    (text: string) => onIdentityChange({ systemPromptExtension: text }),
    [onIdentityChange],
  );
  return (
    <ModernPage>
      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.instructions"
        title="Standing instructions"
        hint="Read on every turn"
      >
        <AutosaveTextArea
          ariaLabel="Standing instructions"
          value={identity?.systemPromptExtension ?? ""}
          rows={9}
          mono={false}
          placeholder="We ship on Fridays. Never touch the billing service without asking me first."
          onSave={saveInstructions}
        />
      </ModernSection>
      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.instructions.prompt"
        title="Full prompt"
      >
        <details
          className="rounded-[var(--radius-lg)] border border-[var(--kit-panel-edge)] bg-[var(--kit-panel-bg)]"
          onToggle={(event) => setPromptOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary
            className="cursor-pointer rounded-[var(--radius-lg)] px-3.5 py-2.5 text-[12.5px] font-medium text-[var(--kit-text-2)] outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line)]"
            title="ADE's rules, these instructions, the notes and the live state"
          >
            {promptOpen ? "Hide" : "Show"}
          </summary>
          {promptOpen ? (
            <div className="border-t border-[var(--kit-rule)] p-3.5">
              <CtoPromptPreview pin={pin} />
            </div>
          ) : null}
        </details>
      </ModernSection>
    </ModernPage>
  );
}

/* ── Page ── */

export function CtoSettingsPage(props: CtoSettingsPageProps) {
  const { active = true, pin, identity, sessionId, initialSection = "look", onBack, onIdentityChange } = props;
  const [section, setSection] = useState<CtoSettingsSection>(initialSection);
  const hasProjectSidebar = useHasProjectSidebar();
  const look = useMemo(() => resolveCtoAvatarLook(identity?.avatar), [identity?.avatar]);
  const name = identity?.name?.trim() || "CTO";

  useEffect(() => { setSection(initialSection); }, [initialSection]);

  const entries: ReadonlyArray<{ id: CtoSettingsSection; label: string; icon: React.ReactNode }> = [
    { id: "look", label: "Look", icon: <CtoAvatar look={look} state="idle" size={16} motion="static" /> },
    { id: "brain", label: "Brain", icon: <Brain size={15} /> },
    { id: "memory", label: "Memory", icon: <Notebook size={15} /> },
    { id: "routines", label: "Routines", icon: <ArrowsClockwise size={15} /> },
    { id: "instructions", label: "Instructions", icon: <Scroll size={15} /> },
  ];

  const rail = (
    <nav aria-label={`${name} settings`} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <button
        type="button"
        onClick={onBack}
        className="mx-2 mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium text-[var(--kit-text-2)] outline-none transition-colors hover:bg-[var(--kit-hover)] hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line)]"
      >
        <ArrowLeft size={13} weight="bold" />
        Back to chat
      </button>
      <div className="kit-rule mx-3 my-2" />
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {entries.map((entry) => {
          const selected = entry.id === section;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => setSection(entry.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line)]",
                selected ? "bg-[var(--kit-active)] font-semibold text-fg" : "font-medium text-[var(--kit-text-2)] hover:bg-[var(--kit-hover)] hover:text-fg",
              )}
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center"
                style={{ color: selected ? look.color : "var(--kit-text-3)" }}
              >
                {entry.icon}
              </span>
              {entry.label}
            </button>
          );
        })}
      </div>
    </nav>
  );

  const pane = (() => {
    switch (section) {
      case "look":
        return <LookPane identity={identity} onIdentityChange={onIdentityChange} />;
      case "brain":
        return <BrainPane {...props} name={name} />;
      case "memory":
        return <ModernPage><CtoMemoryPanel pin={pin} sessionId={sessionId} /></ModernPage>;
      case "routines":
        return (
          <ModernPage>
            <ModernSection
              group={CTO_SETTINGS_GROUP}
              anchor="cto.routines"
              title="Routines"
              hint="Ask in chat to add one"
            >
              <CtoRoutineRows sessionId={sessionId} pin={pin} variant="settings" />
            </ModernSection>
          </ModernPage>
        );
      case "instructions":
        return <InstructionsPane pin={pin} identity={identity} onIdentityChange={onIdentityChange} />;
      default:
        return null;
    }
  })();

  return (
    <div
      className="flex min-h-0 flex-1"
      data-testid="cto-settings-page"
      style={{
        ["--cto-accent" as string]: look.color,
        ["--cto-accent-line" as string]: `color-mix(in srgb, ${look.color} 40%, transparent)`,
      }}
    >
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>{rail}</ProjectSidebarSlot>
      ) : (
        <div className="flex w-[196px] shrink-0 flex-col border-r border-[var(--kit-rule)]">{rail}</div>
      )}
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="px-8 py-7" style={{ maxWidth: 780 }}>
          {pane}
        </div>
      </div>
    </div>
  );
}
