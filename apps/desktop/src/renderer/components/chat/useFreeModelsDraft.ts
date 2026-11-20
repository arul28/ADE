import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { isFreeModel, pickFreeDefaultModelId } from "../../../shared/freeModels";
import type { AiSettingsStatus, OpenProjectBinding } from "../../../shared/types";
import { subscribeToolInstalled } from "../../lib/toolsCacheEvents";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { fetchSharedRuntimeCatalog } from "../shared/ModelPicker/sharedCatalogFetch";

function isFreeInScope(modelId: string, scopeKey: string): boolean {
  return isFreeModel(resolveModelDescriptorWithRuntimeCatalog(modelId, scopeKey) ?? { id: modelId });
}

type ModelChangeRef = MutableRefObject<((modelId: string) => void) | null>;

/**
 * Free models (`shared/freeModels.ts`) in a chat pane's draft, from the
 * composer machine's AI status:
 *
 * - with nothing signed in there, a fresh draft starts on a free model;
 * - OpenCode's catalog loads without a picker, so that model is known;
 * - a new person's sign-in strip offers "Use a free model";
 * - a sign-in on the machine puts the draft back on the model it opened on,
 *   once that model can run.
 *
 * The free default is ADE's pick: it is not remembered as the machine's
 * launch default or as "last used", and any model someone chose wins.
 */
export function useFreeModelsDraft(args: {
  aiStatus: AiSettingsStatus | null;
  /** The composer's model list: the models that can run now. */
  availableModelIds: readonly string[];
  /** The composer machine's runtime catalog key. */
  catalogScopeKey: string;
  /** The composer machine's binding; the catalog load goes there. */
  runtimeBinding: OpenProjectBinding | null;
  /** Non-null when the composer machine is not this tab's: no local tools push then. */
  remotePin: OpenProjectBinding | null;
  selectedSessionId: string | null;
  /**
   * A fresh chat draft the person runs here with the composer's own model:
   * not a subagent, a cloud or CLI draft, a parallel set or a narrowed list.
   */
  freshDraft: boolean;
  modelId: string;
  /** The composer's model and preferences have loaded. */
  composerReady: boolean;
  /** A person's model choice: sets `draftModelChosenRef`. */
  chooseModelRef: ModelChangeRef;
  /** The same change for ADE's own pick: not a choice. */
  adeModelChangeRef: ModelChangeRef;
  /** Set to keep ADE's pick out of the launch defaults and "last used". */
  draftKeepsMachineDefaultsRef: MutableRefObject<boolean>;
  /** True once a person, a caller or a restored draft chose the model. The pane resets it per draft. */
  draftModelChosenRef: MutableRefObject<boolean>;
  refreshAvailableModels: (options?: { revalidate?: boolean }) => Promise<unknown>;
  onCatalogLoaded: () => void;
}): { offerFreeModel: boolean; handleUseFreeModel: () => void } {
  const {
    aiStatus,
    availableModelIds,
    catalogScopeKey,
    runtimeBinding,
    remotePin,
    selectedSessionId,
    freshDraft,
    modelId,
    composerReady,
    chooseModelRef,
    adeModelChangeRef,
    draftKeepsMachineDefaultsRef,
    draftModelChosenRef,
    refreshAvailableModels,
    onCatalogLoaded,
  } = args;
  const status = aiStatus?.freeModels ?? null;
  const nothingSignedIn = status?.nothingSignedIn === true;
  const opencodeInstalled = aiStatus?.opencodeBinaryInstalled === true;
  const freeModelIds = useMemo(
    () => availableModelIds.filter((id) => isFreeInScope(id, catalogScopeKey)),
    [availableModelIds, catalogScopeKey],
  );
  const freeDefaultModelId = useMemo(
    () => (status ? pickFreeDefaultModelId(freeModelIds, status.preferredDefaultModelIds) : null),
    [freeModelIds, status],
  );
  const latestRef = useRef({ onCatalogLoaded, runtimeBinding });
  latestRef.current = { onCatalogLoaded, runtimeBinding };
  const runtimeBindingKey = runtimeBinding?.key ?? null;
  const remotePinKey = remotePin?.key ?? null;

  // Free models come from OpenCode's catalog, which loads when a picker opens
  // it. With nothing signed in, load it for the composer's machine, so a new
  // chat can start on a free model before anyone opens the picker.
  const catalogRequestedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!freshDraft || !nothingSignedIn || !opencodeInstalled || freeModelIds.length > 0) return;
    if (catalogRequestedForRef.current === catalogScopeKey) return;
    const scopeKey = catalogScopeKey;
    catalogRequestedForRef.current = scopeKey;
    void fetchSharedRuntimeCatalog({
      scopeKey,
      mode: "refresh-stale",
      refreshProvider: "opencode",
      pin: latestRef.current.runtimeBinding,
    }).then((result) => {
      if (result.status === "ok") {
        latestRef.current.onCatalogLoaded();
      } else if (catalogRequestedForRef.current === scopeKey) {
        catalogRequestedForRef.current = null;
      }
    });
    // `aiStatus` is the retry trigger: a load that failed runs again on the
    // next status re-read.
  }, [aiStatus, catalogScopeKey, freeModelIds.length, freshDraft, nothingSignedIn, opencodeInstalled, runtimeBindingKey]);

  // OpenCode is still downloading on this computer (it downloads at launch
  // when no agent is set up): re-read the status when it lands, and the
  // effect above then loads the free models.
  useEffect(() => {
    if (!freshDraft || !nothingSignedIn || opencodeInstalled || remotePinKey) return undefined;
    return subscribeToolInstalled("opencode", () => {
      void refreshAvailableModels({ revalidate: true });
    });
  }, [freshDraft, nothingSignedIn, opencodeInstalled, refreshAvailableModels, remotePinKey]);

  /** The draft's opening model, and the free model ADE put in its place. */
  const freeDefaultRef = useRef<{ baseModelId: string | null; settled: boolean; appliedId: string | null }>({
    baseModelId: null,
    settled: false,
    appliedId: null,
  });
  useEffect(() => {
    // Opening a chat, or leaving one for a new draft: the next draft decides
    // again. The pane resets `draftModelChosenRef` itself, before the effects
    // that set it.
    freeDefaultRef.current = { baseModelId: null, settled: false, appliedId: null };
  }, [selectedSessionId]);
  useEffect(() => {
    const state = freeDefaultRef.current;
    if (state.settled || !freshDraft || !composerReady || !nothingSignedIn) return;
    if (state.baseModelId === null) state.baseModelId = modelId;
    // A model someone chose wins, also one chosen before the status arrived,
    // and so does a model that is already free.
    if (draftModelChosenRef.current || modelId !== state.baseModelId || isFreeInScope(modelId, catalogScopeKey)) {
      state.settled = true;
      return;
    }
    if (!freeDefaultModelId || !adeModelChangeRef.current) return;
    state.settled = true;
    state.appliedId = freeDefaultModelId;
    adeModelChangeRef.current(freeDefaultModelId);
    // After the change, which clears the flag as a person's pick would.
    draftKeepsMachineDefaultsRef.current = true;
  }, [adeModelChangeRef, catalogScopeKey, composerReady, draftKeepsMachineDefaultsRef, draftModelChosenRef, freeDefaultModelId, freshDraft, modelId, nothingSignedIn]);

  // Someone signed in on the machine while the draft sat on ADE's free
  // model: put back the model the draft opened on, once that model can run
  // (a Codex sign-in does not make a Claude draft work). A status not read
  // yet (null) is not a sign-in.
  const signedInNow = status != null && !status.nothingSignedIn;
  useEffect(() => {
    const state = freeDefaultRef.current;
    if (!signedInNow || !freshDraft || !state.appliedId || !state.baseModelId) return;
    if (draftModelChosenRef.current || modelId !== state.appliedId) {
      state.appliedId = null;
      return;
    }
    if (!availableModelIds.includes(state.baseModelId)) return;
    state.appliedId = null;
    adeModelChangeRef.current?.(state.baseModelId);
  }, [adeModelChangeRef, availableModelIds, draftModelChosenRef, freshDraft, modelId, signedInNow]);

  const handleUseFreeModel = useCallback(() => {
    if (freeDefaultModelId) chooseModelRef.current?.(freeDefaultModelId);
  }, [chooseModelRef, freeDefaultModelId]);

  // The strip offers a free model only to a brand-new person: nothing signed
  // in now, and nothing ever signed in on this machine. An open chat can
  // change to it too (a chat takes any model).
  const offerFreeModel = nothingSignedIn
    && status?.everSignedIn === false
    && freeDefaultModelId != null;

  return { offerFreeModel, handleUseFreeModel };
}
