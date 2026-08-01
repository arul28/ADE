import { useMemo } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  buildChatMachineRoutingState,
  collectOpenProjectBindings,
  createChatMachineRouter,
  type ChatMachineRouter,
  type LaneBindingSource,
} from "../../lib/chatMachineRouting";
import { useAppStore, useRootAppStore } from "../../state/appStore";
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
  /** Resolve lane ownership first, then the remembered per-launch fallback. */
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
 */
export function useWorkMachineRouter(): WorkMachineRouter {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lanes = useAppStore((s) => s.lanes);
  const openRemoteProjectTabs = useAppStore((s) => s.openRemoteProjectTabs);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const crossMachineLanesByMachineId = useRootAppStore((s) => s.crossMachineLanesByMachineId);

  return useMemo(() => {
    const machines = Object.values(crossMachineLanesByMachineId ?? {});
    const openBindings = collectOpenProjectBindings({
      activeBinding: projectBinding ?? null,
      remoteBindings: openRemoteProjectTabs ?? [],
      localProjects: (openProjectTabRoots ?? []).map((rootPath) => ({ rootPath })),
      additionalBindings: machines.map((machine) => machine.binding),
    });
    const additionalLaneSources: LaneBindingSource[] = [];
    for (const machine of machines) {
      if (!machine.binding) continue;
      additionalLaneSources.push({
        bindingKey: machine.binding.key,
        laneIds: machine.lanes.map((lane) => lane.id),
      });
    }
    const router = createChatMachineRouter(buildChatMachineRoutingState({
      activeBinding: projectBinding ?? null,
      openBindings,
      activeLaneIds: (lanes ?? []).map((lane) => lane.id),
      additionalLaneSources,
    }));

    return {
      ...router,
      pinForSession: (session) => {
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
        rememberWorkPtyLaunchPin(session, pin);
      },
      forgetSessionPin: (session) => {
        forgetWorkPtyLaunchPin(session);
      },
    };
  }, [crossMachineLanesByMachineId, lanes, openProjectTabRoots, openRemoteProjectTabs, projectBinding]);
}
