import type { OpenProjectBinding } from "../../shared/types/core";

/**
 * Per-chat runtime routing.
 *
 * A lane owns its machine. A chat inherits its machine from its lane via
 * `laneId` — there is deliberately NO machine field on a chat. The Work sidebar
 * is a union across every open machine, so the user can click a chat that lives
 * on a machine the window's project tab is not bound to. Those calls must reach
 * THAT machine without rebinding the tab (rebinding would drag Lanes/PRs/Files
 * along with it).
 *
 * This module is the pure derivation of "which binding must this chat's calls
 * target". It resolves to `null` whenever the chat already lives on the active
 * binding, so callers take the existing unpinned path with zero extra work —
 * the common case must stay indistinguishable from before per-chat routing.
 */

/** A lane→binding association contributed by one open project binding. */
export type LaneBindingSource = {
  /** `OpenProjectBinding.key` of the machine that owns these lanes. */
  bindingKey: string;
  /** Lane ids known to live on that binding. */
  laneIds: readonly string[];
};

/** Lane id → owning `OpenProjectBinding.key`. */
export type LaneBindingIndex = ReadonlyMap<string, string>;

export type ChatMachineRoutingState = {
  /** The binding this window's project tab is currently bound to. */
  activeBinding: OpenProjectBinding | null;
  /** Every binding currently open in this window (tabs), including the active one. */
  openBindings: readonly OpenProjectBinding[];
  /** Lane ownership across those bindings. */
  laneBindingIndex: LaneBindingIndex;
};

export type OpenProjectBindingCollectionArgs = {
  activeBinding: OpenProjectBinding | null;
  remoteBindings?: readonly (OpenProjectBinding | null | undefined)[];
  localProjects?: readonly { rootPath: string; displayName?: string | null }[];
  additionalBindings?: readonly (OpenProjectBinding | null | undefined)[];
};

/** Collect and de-duplicate every project binding that is open in this window. */
export function collectOpenProjectBindings(
  args: OpenProjectBindingCollectionArgs,
): OpenProjectBinding[] {
  const bindings: OpenProjectBinding[] = [];
  const seen = new Set<string>();
  const push = (binding: OpenProjectBinding | null | undefined) => {
    if (!binding || seen.has(binding.key)) return;
    seen.add(binding.key);
    bindings.push(binding);
  };

  push(args.activeBinding);
  for (const binding of args.remoteBindings ?? []) push(binding);
  for (const project of args.localProjects ?? []) {
    const rootPath = normalizeId(project.rootPath);
    if (!rootPath) continue;
    push({
      kind: "local",
      key: `local:${rootPath}`,
      rootPath,
      displayName: project.displayName?.trim() || rootPath,
    });
  }
  for (const binding of args.additionalBindings ?? []) push(binding);
  return bindings;
}

export type ChatMachineRoutingStateArgs = {
  activeBinding: OpenProjectBinding | null;
  openBindings: readonly OpenProjectBinding[];
  activeLaneIds?: readonly string[];
  additionalLaneSources?: readonly LaneBindingSource[];
};

/** Build router state with the active binding's live lanes taking precedence. */
export function buildChatMachineRoutingState(
  args: ChatMachineRoutingStateArgs,
): ChatMachineRoutingState {
  const sources: LaneBindingSource[] = [];
  if (args.activeBinding) {
    sources.push({
      bindingKey: args.activeBinding.key,
      laneIds: args.activeLaneIds ?? [],
    });
  }
  sources.push(...(args.additionalLaneSources ?? []));
  return {
    activeBinding: args.activeBinding,
    openBindings: args.openBindings,
    laneBindingIndex: buildLaneBindingIndex(sources),
  };
}

function normalizeId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Fold per-binding lane lists into a single lane→bindingKey index.
 *
 * Earlier sources win: callers pass the active binding first so a lane that is
 * (stale-)cached under two bindings resolves to the one the user is looking at.
 */
export function buildLaneBindingIndex(
  sources: readonly LaneBindingSource[],
): LaneBindingIndex {
  const index = new Map<string, string>();
  for (const source of sources) {
    const bindingKey = normalizeId(source.bindingKey);
    if (!bindingKey) continue;
    for (const laneId of source.laneIds) {
      const id = normalizeId(laneId);
      if (!id || index.has(id)) continue;
      index.set(id, bindingKey);
    }
  }
  return index;
}

/** The binding key that owns `laneId`, or null when the lane is unknown. */
export function resolveLaneBindingKey(
  state: Pick<ChatMachineRoutingState, "laneBindingIndex">,
  laneId: string | null | undefined,
): string | null {
  const id = normalizeId(laneId);
  if (!id) return null;
  return state.laneBindingIndex.get(id) ?? null;
}

/**
 * The `OpenProjectBinding` a chat's runtime calls must be pinned to, or `null`
 * when no pin is needed.
 *
 * `null` means "take the existing bound path", which is correct for all three
 * of: the chat lives on the active binding, the lane's owner is unknown, and
 * the lane's owner is not open in this window (nothing to route to — the bound
 * path's own fallbacks are strictly better than inventing a target).
 */
export function resolveChatRuntimePin(
  state: ChatMachineRoutingState,
  laneId: string | null | undefined,
): OpenProjectBinding | null {
  const bindingKey = resolveLaneBindingKey(state, laneId);
  if (!bindingKey) return null;
  if (state.activeBinding && state.activeBinding.key === bindingKey) return null;
  return state.openBindings.find((binding) => binding.key === bindingKey) ?? null;
}

/**
 * Is `pin` still a live target — i.e. a binding this window still has open?
 *
 * INTEGRATION NOTE (must not be lost):
 * `useWorkSessions.canMutatePinnedProjectUi` delegates to the Work machine
 * router's instance of this predicate, and `AgentChatPane` calls it directly.
 * Keep both on open-binding liveness: requiring `activeBinding.key === pin.key`
 * would drop the normal, correct updates for every foreign session.
 */
export function isLivePinnedBinding(
  pin: { key: string } | null | undefined,
  openBindings: readonly OpenProjectBinding[],
): boolean {
  if (!pin) return true;
  const key = normalizeId(pin.key);
  if (!key) return true;
  return openBindings.some((binding) => binding.key === key);
}

export type ChatMachineRouter = {
  /** Resolved pin for a chat on `laneId`, or null for the active binding. */
  pinForLane: (laneId: string | null | undefined) => OpenProjectBinding | null;
  /** See `isLivePinnedBinding`. */
  isLivePin: (pin: { key: string } | null | undefined) => boolean;
};

/**
 * Memoized router over an immutable routing state. Resolution is a pure
 * derivation over renderer state that already exists — no IPC, no polling —
 * and repeated lookups for the same lane hit the cache, so a chat on the active
 * binding costs one Map read and allocates nothing per call.
 */
export function createChatMachineRouter(
  state: ChatMachineRoutingState,
): ChatMachineRouter {
  const cache = new Map<string, OpenProjectBinding | null>();
  return {
    pinForLane: (laneId) => {
      const id = normalizeId(laneId);
      if (!id) return null;
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const pin = resolveChatRuntimePin(state, id);
      cache.set(id, pin);
      return pin;
    },
    isLivePin: (pin) => isLivePinnedBinding(pin, state.openBindings),
  };
}
