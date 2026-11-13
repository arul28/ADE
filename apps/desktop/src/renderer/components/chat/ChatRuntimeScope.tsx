import React, { createContext, useContext, useMemo } from "react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import type { LaneSummary } from "../../../shared/types/lanes";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { machineLabelForBinding, useAdeCloudLaneComputers, useMachineLabelForBinding } from "../../state/adeCloudLaneIndex";
import {
  useForeignSessionLaneId,
  useLanesForPin,
  useMachineEntryForBinding,
} from "../../state/crossMachineLanes";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { isActiveBindingPin } from "../../lib/chatMachineRouting";

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
 * carried down the panel/drawer subtree. `pin` addresses the chat's copy, the
 * tab's own included; "is this the tab's copy" is `isActiveBinding`, never a
 * null pin. A pin that names the tab's copy costs what no pin cost (preload
 * `isBoundCopyPin`).
 */
/**
 * The machine half, answerable from a pin and a lane alone.
 *
 * Split out because `useChatRuntimeScopeForPin` can answer exactly this and no
 * more — which chat is being rendered is the provider's to add.
 */
export type ChatMachineScope = {
  /**
   * Pass to any pin-aware preload call: the chat's copy, the tab's own
   * included. Null only when the chat's machine is not known (the call then
   * takes the tab's bound machine, as before).
   */
  pin: OpenProjectBinding | null;
  /** Whether the chat runs on the copy the tab is bound to (or its machine is unknown). */
  isActiveBinding: boolean;
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

export type ChatRuntimeScope = ChatMachineScope & {
  /**
   * The chat being rendered. Null outside a chat subtree.
   *
   * Session-constant, so it belongs here rather than threaded through the
   * presentation components between the message list and whatever needs it —
   * proof filing, for one, is chat-scoped and had been drilled three deep.
   */
  sessionId: string | null;
};

const FALLBACK_SCOPE: ChatRuntimeScope = {
  pin: null,
  isActiveBinding: true,
  binding: null,
  laneId: null,
  sessionId: null,
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
/**
 * The lane list of the machine a pin names: that machine's slice when the chat
 * is pinned, else the tab-bound lanes. Surfaces that show every lane of the
 * chat's machine (the browser's lane groups) read this, not `state.lanes`.
 */
export function useChatMachineLanes(pin: OpenProjectBinding | null): LaneSummary[] {
  const pinnedLanes = useLanesForPin(pin);
  const boundLanes = useAppStore((state) => state.lanes);
  return pinnedLanes ?? boundLanes;
}

/**
 * Does the chat run on this computer, on the tab's own copy? Only then do its
 * file paths open here and does main's focus reconcile reach its project.
 */
export function chatRunsOnThisComputer(scope: Pick<ChatMachineScope, "isActiveBinding" | "isRemote">): boolean {
  return !scope.isRemote && scope.isActiveBinding;
}

export function useChatRuntimeScopeForPin(
  pin: OpenProjectBinding | null,
  laneId: string | null,
  bindingOverride?: OpenProjectBinding | null,
): ChatMachineScope {
  // The pinned machine's own slice of the cross-machine union. A foreign lane
  // is absent from the tab-bound `lanes` array, so its worktree path — and
  // therefore the iOS / App Control project root — is only knowable from here.
  const pinnedMachine = useMachineEntryForBinding(pin);
  const lanes = useChatMachineLanes(pin);
  const boundProjectRoot = useAppStore(selectActiveProjectRoot);
  const boundBinding = useAppStore((state) => state.projectBinding);
  // A cloud lane computer reads "Cloud · <lane>", never its generated name.
  const { computers: cloudComputers } = useAdeCloudLaneComputers();

  return useMemo<ChatMachineScope>(() => {
    const binding = bindingOverride !== undefined ? bindingOverride : (pin ?? boundBinding ?? null);
    const lane = laneId ? lanes.find((entry) => entry.id === laneId) ?? null : null;
    const isActiveBinding = !pin || isActiveBindingPin(pin, boundBinding);
    return {
      pin,
      isActiveBinding,
      binding,
      laneId,
      lane,
      laneWorktreePath: lane?.worktreePath ?? null,
      rootPath: pin && !isActiveBinding ? pin.rootPath : boundProjectRoot,
      isRemote: binding?.kind === "remote",
      machineName: machineLabelForBinding(binding, cloudComputers),
      // Only another machine can be known-offline. The bound machine's own
      // liveness is the window's problem, not this chat's.
      online: isActiveBinding || pinnedMachine?.online !== false,
    };
  }, [
    bindingOverride,
    boundBinding,
    boundProjectRoot,
    cloudComputers,
    laneId,
    lanes,
    pin,
    pinnedMachine,
  ]);
}

/** A lane as the handoff lane picker needs it — LaneSummary is assignable. */
export type ChatScopeLaneOption = {
  id: string;
  name: string;
  color?: string | null;
  emoji?: string | null;
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
  /**
   * Host-resolved pin for a locked Work chat. `undefined` derives from the
   * lane as before. `null` means the host does not know the chat's machine
   * (the tab's bound machine is used, as before).
   */
  pinOverride?: OpenProjectBinding | null;
  /** The tab machine's lanes, and the pane's preferred picker list. */
  lanes: LaneSummary[];
  availableLanes?: ChatScopeLaneOption[];
};

export type ChatScopeDerivation = {
  /** The lane this chat lives in, on its own machine. */
  chatScopeLaneId: string | null;
  /** Pin for every chat-scoped call, the tab's own copy included. Null = unknown. */
  chatRuntimePin: OpenProjectBinding | null;
  /**
   * `chatRuntimePin` when it names another copy than the tab's own; null for
   * the tab's copy. Branches that mean "another machine" read this, not the pin.
   */
  chatForeignPin: OpenProjectBinding | null;
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
  pinOverride,
}: ChatScopeDerivationInput): ChatScopeDerivation {
  const foreignSelectedLaneId = useForeignSessionLaneId(
    selectedSessionId,
    Boolean(selectedSession),
  );
  const chatScopeLaneId = selectedSession?.laneId ?? foreignSelectedLaneId ?? laneId ?? null;
  const chatRuntimePin = useMemo(
    () => (pinOverride !== undefined ? pinOverride : chatMachineRouter.pinForLane(chatScopeLaneId)),
    [chatMachineRouter, chatScopeLaneId, pinOverride],
  );
  /**
   * The binding this chat actually runs on. Handoff is a fact about the chat's
   * machine, not about whichever project this tab happens to be bound to: a
   * local chat viewed from a remote-bound tab can still hand off, and a chat
   * pinned to a remote machine cannot — regardless of the tab.
   */
  const chatEffectiveBinding = chatRuntimePin ?? projectBinding ?? null;
  const chatForeignPin = chatRuntimePin && !isActiveBindingPin(chatRuntimePin, projectBinding)
    ? chatRuntimePin
    : null;
  // The chat machine's own lane list, or null for a chat on the tab's copy —
  // which keeps its existing tab-bound source (`availableLanes ?? lanes`).
  const pinnedLanes = useLanesForPin(chatForeignPin);
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

  const chatMachineName = useMachineLabelForBinding(chatEffectiveBinding);
  return {
    chatScopeLaneId,
    chatRuntimePin,
    chatForeignPin,
    chatEffectiveBinding,
    isRemoteChat: chatEffectiveBinding?.kind === "remote",
    chatMachineName,
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
  /** The session the pane is rendering, not the one it has selected. */
  sessionId: string | null;
  children: React.ReactNode;
};

export function ChatRuntimeScopeProvider({
  pin,
  binding,
  laneId,
  sessionId,
  children,
}: ChatRuntimeScopeProviderProps) {
  const machineScope = useChatRuntimeScopeForPin(pin, laneId, binding);
  const scope = useMemo(() => ({ ...machineScope, sessionId }), [machineScope, sessionId]);
  return (
    <ChatRuntimeScopeContext.Provider value={scope}>
      {children}
    </ChatRuntimeScopeContext.Provider>
  );
}
