import { useMemo } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  buildChatMachineRoutingState,
  collectOpenProjectBindings,
  createChatMachineRouter,
  effectiveRuntimeBinding,
  isLivePinnedBinding,
  type ChatMachineRouter,
  type LaneBindingSource,
} from "../../lib/chatMachineRouting";
import {
  useAppStore,
  useRootAppStore,
  type CrossMachineMachineLanes,
} from "../../state/appStore";
import {
  forgetWorkPtyLaunchPin,
  rememberWorkPtyLaunchPin,
  workPtyLaunchPinFor,
} from "./cliLaunch";

type WorkRuntimePinLookup = {
  id?: string | null;
  sessionId?: string | null;
  ptyId?: string | null;
  laneId?: string | null;
};

export type WorkMachineRouter = ChatMachineRouter & {
  /** Resolve session-slice ownership, lane ownership, then the remembered launch fallback. */
  pinForSession: (session: WorkRuntimePinLookup) => OpenProjectBinding | null;
  /** Keep the launch-pin registry behind the Work routing authority. */
  rememberSessionPin: (
    session: WorkRuntimePinLookup,
    pin: OpenProjectBinding | null | undefined,
  ) => void;
  /** Remove both the session-id and PTY-id entries from the launch-pin registry. */
  forgetSessionPin: (session: WorkRuntimePinLookup) => void;
};

/**
 * Per-session runtime routing for the Work tab.
 *
 * Same model as the chat pane's router (see `lib/chatMachineRouting`): a lane
 * owns its machine, a session inherits its machine from its lane, and the pin
 * resolves to `null` whenever that machine is the one the project tab is
 * already bound to — so every local session keeps taking the existing unpinned
 * path with no extra work.
 *
 * This exists so a CLI/shell session is routed exactly like a chat. The Work
 * sidebar is a union across machines, and clicking a row must reach ITS machine
 * without rebinding the tab (rebinding would drag Lanes/PRs/Files along).
 * Work tools follow that same session machine: a sticky effective pin survives
 * the tab dropdown moving underneath an open session.
 */
export function useWorkMachineRouter(
  crossMachineSlices: readonly CrossMachineMachineLanes[],
): WorkMachineRouter {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lanes = useAppStore((s) => s.lanes);
  const openRemoteProjectTabs = useAppStore((s) => s.openRemoteProjectTabs);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const liveCrossMachineSlices = useRootAppStore((s) => s.crossMachineLanesByMachineId);

  return useMemo(() => {
    const machines = crossMachineSlices;
    const openBindings = collectOpenProjectBindings({
      activeBinding: projectBinding ?? null,
      remoteBindings: openRemoteProjectTabs ?? [],
      localProjects: (openProjectTabRoots ?? []).map((rootPath) => ({ rootPath })),
      additionalBindings: machines.map((machine) => machine.binding),
    });
    const additionalLaneSources: LaneBindingSource[] = [];
    // Session ids are globally stable across the Work union, while lane ids can
    // legitimately exist on more than one machine. Preserve the owning slice's
    // binding in a parallel index instead of decorating TerminalSessionSummary
    // rows or depending on the transient launch-pin registry. Build it only
    // when a machine actually contributes sessions, and only when the memoized
    // router inputs change, so the local-only render path allocates nothing.
    let sessionBindingsById: Map<string, OpenProjectBinding> | null = null;
    for (const machine of machines) {
      if (!machine.binding) continue;
      additionalLaneSources.push({
        bindingKey: machine.binding.key,
        laneIds: machine.lanes.map((lane) => lane.id),
      });
      for (const session of machine.sessions) {
        const sessionId = session.id?.trim();
        if (!sessionId) continue;
        sessionBindingsById ??= new Map();
        if (!sessionBindingsById.has(sessionId)) {
          sessionBindingsById.set(sessionId, machine.binding);
        }
      }
    }
    const router = createChatMachineRouter(buildChatMachineRoutingState({
      activeBinding: projectBinding ?? null,
      openBindings,
      activeLaneIds: (lanes ?? []).map((lane) => lane.id),
      additionalLaneSources,
    }));
    // Runtime ownership survives the refill, but liveness keeps its existing
    // contract: only bindings present in the live store (or open project tabs)
    // may mutate UI state. This preserves the sticky-pin fallback's behavior
    // while retained session/lane indexes keep calls aimed at the right machine.
    const liveOpenBindings = collectOpenProjectBindings({
      activeBinding: projectBinding ?? null,
      remoteBindings: openRemoteProjectTabs ?? [],
      localProjects: (openProjectTabRoots ?? []).map((rootPath) => ({ rootPath })),
      additionalBindings: Object.values(liveCrossMachineSlices).map((machine) => machine.binding),
    });

    return {
      ...router,
      isLivePin: (pin) => isLivePinnedBinding(pin, liveOpenBindings),
      pinForSession: (session) => {
        const sessionId = session.sessionId ?? session.id ?? null;
        const slicePin = sessionId ? sessionBindingsById?.get(sessionId) : undefined;
        if (slicePin) {
          // The retained cross-machine map can include the active remote
          // binding's slice. Its session identity is authoritative too, but it
          // still takes the existing unpinned path.
          return slicePin.key === projectBinding?.key ? null : slicePin;
        }
        const lanePin = router.pinForLane(session.laneId);
        if (lanePin) return lanePin;
        const rememberedPin = workPtyLaunchPinFor(session);
        // A remembered pin can become the active binding after the tab is
        // rebound. Keep that case on the unpinned fast path; the pinned path has
        // no local IPC fallback and would create a redundant event pump.
        if (!rememberedPin || rememberedPin.key === projectBinding?.key) return null;
        // Do not liveness-gate the remembered foreign pin here. The
        // cross-machine lane scope is replaced wholesale while it reloads, so
        // an otherwise healthy binding briefly disappears from `openBindings`.
        // Keeping the pin makes that short window fail against the RIGHT
        // machine and recover when the scope returns. Falling back to the
        // unpinned path would silently query the tab's machine, discard the
        // parked terminal buffer, and hydrate a foreign session id there.
        // Click-time rebinding still uses `isLivePin`; only runtime ownership
        // remembered for an already-open session survives this transient flap.
        return rememberedPin;
      },
      rememberSessionPin: (session, pin) => {
        const existing = workPtyLaunchPinFor(session);
        const effective = effectiveRuntimeBinding(pin, projectBinding);
        if (!effective) return;
        // A null pin means "the bound path", not "forget this machine". After
        // the tab dropdown moves, callers still pass null for a session that
        // was on the old bound machine; replacing the sticky foreign pin with
        // the new tab would silently retarget Git/Terminal/Browser.
        if (existing && !pin && existing.key !== effective.key) return;
        rememberWorkPtyLaunchPin(session, effective);
      },
      forgetSessionPin: (session) => {
        forgetWorkPtyLaunchPin(session);
      },
    };
  }, [crossMachineSlices, lanes, liveCrossMachineSlices, openProjectTabRoots, openRemoteProjectTabs, projectBinding]);
}
