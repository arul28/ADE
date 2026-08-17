import React, { createContext, useContext, useMemo } from "react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import type { LaneSummary } from "../../../shared/types/lanes";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { selectActiveProjectRoot, useAppStore, useRootAppStore } from "../../state/appStore";

/**
 * The one answer to "which machine is THIS chat on, and what does it look like
 * there".
 *
 * A lane owns its machine and a chat inherits its machine from its lane, but a
 * Work tab unions chats from every machine on the account. So every chat-scoped
 * surface — Git toolbar, iOS simulator, App Control, browser, file changes, PR
 * pane, terminals — has two candidate answers available to it: the chat's
 * machine, and whatever machine the project tab happens to be bound to. Reading
 * the tab's machine is wrong in exactly the case that matters, and it is the
 * reading every global `useAppStore` selector gives you.
 *
 * `useChatRuntimeScope()` is that answer, resolved once by `AgentChatPane` and
 * carried down the panel/drawer subtree. `pin === null` means, and only means,
 * "this chat lives on the tab's binding" — the unpinned path, byte-for-byte
 * what the surface did before per-chat routing.
 */
export type ChatRuntimeScope = {
  /** Pass to any pin-aware preload call. Null = the tab's bound machine. */
  pin: OpenProjectBinding | null;
  /** The binding the chat actually runs on: `pin ?? projectBinding`. */
  binding: OpenProjectBinding | null;
  /** The chat's lane, on that machine. */
  laneId: string | null;
  /** That lane's row, read from the chat's machine — not the tab's. */
  lane: LaneSummary | null;
  /** That lane's worktree path, resolved on the chat's machine. */
  laneWorktreePath: string | null;
  /** The chat's project root on its machine, lane-independent. */
  rootPath: string | null;
  /** Does the chat run on a remote machine? Not "is the tab remote". */
  isRemote: boolean;
  /** Absolute machine name — "This computer" or "MacBook Pro (97)". */
  machineName: string;
  /** False only when the chat's pinned machine is known to be unreachable. */
  online: boolean;
};

const FALLBACK_SCOPE: ChatRuntimeScope = {
  pin: null,
  binding: null,
  laneId: null,
  lane: null,
  laneWorktreePath: null,
  rootPath: null,
  isRemote: false,
  machineName: THIS_MACHINE_NAME,
  online: true,
};

const ChatRuntimeScopeContext = createContext<ChatRuntimeScope | null>(null);

/**
 * The scope for the surrounding chat.
 *
 * Outside a provider this returns the unpinned, local, online fallback, which
 * is how a chat-less surface (a bare preview, a test harness) should behave:
 * the bound machine, no pin, no extra argument on any call.
 */
export function useChatRuntimeScope(): ChatRuntimeScope {
  return useContext(ChatRuntimeScopeContext) ?? FALLBACK_SCOPE;
}

/**
 * The same scope, derived from a pin handed in as a prop.
 *
 * For surfaces that are reused outside a chat pane — the CLI session header
 * renders `ChatGitToolbar` with its own pin and no provider above it — so the
 * derivation cannot come from context. Inside a pane, prefer
 * `useChatRuntimeScope()`.
 */
export function useChatRuntimeScopeForPin(
  pin: OpenProjectBinding | null,
  laneId: string | null,
  bindingOverride?: OpenProjectBinding | null,
): ChatRuntimeScope {
  // The pinned machine's own slice of the cross-machine union. A foreign lane
  // is absent from the tab-bound `lanes` array, so its worktree path — and
  // therefore the iOS / App Control project root — is only knowable from here.
  const pinnedMachine = useRootAppStore((state) => {
    if (!pin) return null;
    for (const entry of Object.values(state.crossMachineLanesByMachineId)) {
      if (entry.binding?.key === pin.key) return entry;
    }
    return null;
  });
  const pinnedLaneCache = useAppStore((state) => (
    pin ? state.laneCacheByProject[pin.kind === "remote" ? pin.key : pin.rootPath] ?? null : null
  ));
  const boundLanes = useAppStore((state) => state.lanes);
  const boundProjectRoot = useAppStore(selectActiveProjectRoot);
  const boundBinding = useAppStore((state) => state.projectBinding);

  return useMemo<ChatRuntimeScope>(() => {
    const binding = bindingOverride !== undefined ? bindingOverride : (pin ?? boundBinding ?? null);
    const lanes = pin ? (pinnedMachine?.lanes ?? pinnedLaneCache?.lanes ?? []) : boundLanes;
    const lane = laneId ? lanes.find((entry) => entry.id === laneId) ?? null : null;
    return {
      pin,
      binding,
      laneId,
      lane,
      laneWorktreePath: lane?.worktreePath ?? null,
      rootPath: pin ? pin.rootPath : boundProjectRoot,
      isRemote: binding?.kind === "remote",
      machineName: binding?.kind === "remote"
        ? (binding.runtimeName || binding.displayName)
        : THIS_MACHINE_NAME,
      // Only a pinned machine can be known-offline. The bound machine's own
      // liveness is the window's problem, not this chat's.
      online: !pin || pinnedMachine?.online !== false,
    };
  }, [
    bindingOverride,
    boundBinding,
    boundLanes,
    boundProjectRoot,
    laneId,
    pin,
    pinnedLaneCache,
    pinnedMachine,
  ]);
}

/**
 * Spread helper for the trailing `pin?` parameter.
 *
 * An unpinned chat must pass no extra argument at all, so its calls stay
 * byte-for-byte the ones the surface made before per-chat routing existed.
 */
export function chatScopePinArgs(
  pin: OpenProjectBinding | null | undefined,
): readonly [OpenProjectBinding] | readonly [] {
  return pin ? ([pin] as const) : ([] as const);
}

export type ChatRuntimeScopeProviderProps = {
  /**
   * Resolved by `AgentChatPane` from the chat machine router. Not recomputed
   * here: the pane already owns the selected/rendered session distinction and
   * the frozen-per-operation ref, and a second derivation would drift from it.
   */
  pin: OpenProjectBinding | null;
  /** `pin ?? projectBinding`, as the pane computes it. */
  binding: OpenProjectBinding | null;
  laneId: string | null;
  children: React.ReactNode;
};

export function ChatRuntimeScopeProvider({
  pin,
  binding,
  laneId,
  children,
}: ChatRuntimeScopeProviderProps) {
  const scope = useChatRuntimeScopeForPin(pin, laneId, binding);
  return (
    <ChatRuntimeScopeContext.Provider value={scope}>
      {children}
    </ChatRuntimeScopeContext.Provider>
  );
}
