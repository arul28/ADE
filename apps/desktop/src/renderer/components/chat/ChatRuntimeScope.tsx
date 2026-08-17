import React, { createContext, useContext, useMemo } from "react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import type { LaneSummary } from "../../../shared/types/lanes";
import { THIS_MACHINE_NAME, machineNameForBinding } from "../../../shared/machineIdentity";
import {
  useForeignSessionLaneId,
  useLanesForPin,
  useMachineEntryForBinding,
} from "../../state/crossMachineLanes";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";

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
  const pinnedMachine = useMachineEntryForBinding(pin);
  const pinnedLanes = useLanesForPin(pin);
  const boundLanes = useAppStore((state) => state.lanes);
  const boundProjectRoot = useAppStore(selectActiveProjectRoot);
  const boundBinding = useAppStore((state) => state.projectBinding);

  return useMemo<ChatRuntimeScope>(() => {
    const binding = bindingOverride !== undefined ? bindingOverride : (pin ?? boundBinding ?? null);
    const lanes = pinnedLanes ?? boundLanes;
    const lane = laneId ? lanes.find((entry) => entry.id === laneId) ?? null : null;
    return {
      pin,
      binding,
      laneId,
      lane,
      laneWorktreePath: lane?.worktreePath ?? null,
      rootPath: pin ? pin.rootPath : boundProjectRoot,
      isRemote: binding?.kind === "remote",
      machineName: machineNameForBinding(binding),
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
    pinnedLanes,
    pinnedMachine,
  ]);
}

/** A lane as the handoff lane picker needs it — LaneSummary is assignable. */
export type ChatScopeLaneOption = {
  id: string;
  name: string;
  color?: string | null;
  branchRef?: string | null;
  laneType?: string | null;
};

export type ChatScopeDerivationInput = {
  /** The chat the pane is routing for. */
  selectedSessionId: string | null;
  /**
   * That session's row, when it is in THIS tab's own list. Null means the chat
   * is not local — the union scan then has to find its lane. One value, because
   * "is it local" and "what is its lane" are the same fact.
   */
  selectedSession: { laneId: string | null } | null;
  /** The pane's lane, used when no chat is selected (drafts, new chats). */
  laneId: string | null;
  chatMachineRouter: { pinForLane: (laneId: string | null) => OpenProjectBinding | null };
  /** The tab's binding — the machine an unpinned chat runs on. */
  projectBinding: OpenProjectBinding | null;
  /** The tab machine's lanes, and the pane's preferred picker list. */
  lanes: LaneSummary[];
  availableLanes?: ChatScopeLaneOption[];
};

export type ChatScopeDerivation = {
  /** The lane this chat lives in, on its own machine. */
  chatScopeLaneId: string | null;
  /** Pin for every chat-scoped call. Null = the tab's own binding. */
  chatRuntimePin: OpenProjectBinding | null;
  /** `chatRuntimePin ?? projectBinding`. */
  chatEffectiveBinding: OpenProjectBinding | null;
  isRemoteChat: boolean;
  /** Absolute machine name for the chat's machine. Never "remote". */
  chatMachineName: string;
  /** Lane picker options on the CHAT's machine. */
  handoffLaneSourceLanes: ChatScopeLaneOption[];
  /** The chat lane's checkout, on the chat's machine. */
  chatLaneWorktreePath: string | null;
};

/**
 * The chat's machine, resolved once for the whole pane.
 *
 * This is the same question {@link useChatRuntimeScopeForPin} answers for a
 * panel, asked one level higher: a pane starts from a *session*, not a pin, and
 * has to find the lane (possibly a foreign one, absent from this tab's session
 * list) before it can find the machine. `AgentChatPane` feeds the result
 * straight into {@link ChatRuntimeScopeProvider}, so the pane and its subtree
 * cannot disagree about which machine the chat is on.
 */
export function useChatScopeDerivation({
  selectedSessionId,
  selectedSession,
  laneId,
  chatMachineRouter,
  projectBinding,
  lanes,
  availableLanes,
}: ChatScopeDerivationInput): ChatScopeDerivation {
  const foreignSelectedLaneId = useForeignSessionLaneId(
    selectedSessionId,
    Boolean(selectedSession),
  );
  const chatScopeLaneId = selectedSession?.laneId ?? foreignSelectedLaneId ?? laneId ?? null;
  const chatRuntimePin = useMemo(
    () => chatMachineRouter.pinForLane(chatScopeLaneId),
    [chatMachineRouter, chatScopeLaneId],
  );
  /**
   * The binding this chat actually runs on. Handoff is a fact about the chat's
   * machine, not about whichever project this tab happens to be bound to: a
   * local chat viewed from a remote-bound tab can still hand off, and a chat
   * pinned to a remote machine cannot — regardless of the tab.
   */
  const chatEffectiveBinding = chatRuntimePin ?? projectBinding ?? null;
  // The chat machine's own lane list, or null for an unpinned chat — which
  // keeps its existing tab-bound source (`availableLanes ?? lanes`) explicitly.
  const pinnedLanes = useLanesForPin(chatRuntimePin);
  /**
   * A brief handoff lands in a lane on the CHAT's machine, so both the picker
   * and the auto-created lane have to target that machine. `availableLanes`/
   * `lanes` describe the tab's bound machine, which is the right answer only
   * for an unpinned chat.
   */
  const handoffLaneSourceLanes = useMemo<ChatScopeLaneOption[]>(
    () => pinnedLanes ?? availableLanes ?? lanes,
    [availableLanes, lanes, pinnedLanes],
  );
  /**
   * The chat's lane checkout, on the chat's own machine. `lanes` is the tab's
   * bound machine, so for a foreign chat it does not contain this lane at all —
   * and the old global fallback silently handed the local project root to a
   * tool that was about to drive another machine.
   */
  const chatLaneWorktreePath = useMemo(() => {
    if (!chatScopeLaneId) return null;
    const source = pinnedLanes ?? lanes;
    return source.find((lane) => lane.id === chatScopeLaneId)?.worktreePath ?? null;
  }, [chatScopeLaneId, lanes, pinnedLanes]);

  return {
    chatScopeLaneId,
    chatRuntimePin,
    chatEffectiveBinding,
    isRemoteChat: chatEffectiveBinding?.kind === "remote",
    chatMachineName: machineNameForBinding(chatEffectiveBinding),
    handoffLaneSourceLanes,
    chatLaneWorktreePath,
  };
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
