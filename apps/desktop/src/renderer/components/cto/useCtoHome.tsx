import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";
import { originUrlForBinding } from "../lanes/laneMachines";
import { useProjectMachines, type ProjectMachine } from "../../state/projectMachines";
import { rememberCtoHomeResolution } from "../../state/ctoHome";
import { arePathsEqual } from "../../lib/pathUtils";
import {
  ctoHomeRecordFor,
  ctoHomeStorageKeys,
  persistCtoHome,
  readAccountCtoHome,
  readLocalCtoHome,
  resolveCtoHomeMachine,
  STILL_IDENTIFYING_THIS_COMPUTER,
  suggestCtoHomeMachine,
  type CtoHomeMachineRecord,
} from "./ctoHomeMachine";

/**
 * Where this project's CTO lives, resolved for the CTO page.
 *
 * `status`:
 *  - `loading`  — the stored choice or the machine list is still arriving.
 *  - `choose`   — no home yet; show the first-run chooser.
 *  - `ready`    — `pin` addresses the home machine (null = the tab's binding).
 *  - `offline`  — a home is chosen but cannot be reached from here right now.
 *
 * Every CTO call must use `pin` and only when `status === "ready"`. Anything
 * else would land on whichever machine the tab happens to be bound to.
 */
export type CtoHomeState = {
  status: "loading" | "choose" | "ready" | "offline";
  pin: OpenProjectBinding | null;
  /** The home machine as this desktop sees it, when it is in the list. */
  home: ProjectMachine | null;
  /** The home's display name, even when this desktop cannot see it. */
  homeName: string | null;
  /** Why an `offline` home cannot be reached, in one sentence. */
  offlineReason: string | null;
  machines: ProjectMachine[];
  suggested: ProjectMachine | null;
  /** True when the account store could not be reached: the choice is only local. */
  localOnly: boolean;
  choose: (machine: ProjectMachine) => Promise<void>;
};

type StoredState = {
  /** Which repository this answer is for; a mismatch means "not loaded". */
  key: string;
  loaded: boolean;
  record: CtoHomeMachineRecord | null;
  localOnly: boolean;
};

/** The repo origin for the tab, found from the binding stamp or the recents list. */
function useRepoOrigin(binding: OpenProjectBinding | null): { loaded: boolean; origin: string | null } {
  const [state, setState] = useState<{ key: string | null; origin: string | null } | null>(null);
  const bindingKey = binding?.key ?? null;
  useEffect(() => {
    let cancelled = false;
    const stamped = originUrlForBinding(binding);
    if (stamped || !binding) {
      setState({ key: bindingKey, origin: stamped });
      return () => { cancelled = true; };
    }
    void (async () => {
      let origin: string | null = null;
      try {
        if (binding.kind === "local") {
          const recents = await window.ade?.project?.listRecent?.();
          origin = recents?.find((project) => arePathsEqual(project.rootPath, binding.rootPath))?.gitOriginUrl ?? null;
        } else {
          const snapshot = await window.ade?.remoteRuntime?.getConnectionSnapshot?.();
          const connection = snapshot?.connections.find((entry) => entry.target.id === binding.targetId);
          origin = connection?.projects?.find((project) => project.projectId === binding.projectId)?.gitOriginUrl ?? null;
        }
      } catch {
        origin = null;
      }
      if (!cancelled) setState({ key: bindingKey, origin });
    })();
    return () => { cancelled = true; };
    // The binding key is the binding's identity; the object is re-created freely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey]);
  if (!state || state.key !== bindingKey) return { loaded: false, origin: null };
  return { loaded: true, origin: state.origin };
}

/**
 * True when there is nothing to choose between: no other machine is connected
 * and none has this repo. The CTO then can only live on This computer, and the
 * page proceeds without asking.
 */
function onlyThisMachine(
  machines: readonly ProjectMachine[],
  connectedRemoteCount: number,
): boolean {
  if (connectedRemoteCount > 0) return false;
  return !machines.some((machine) => !machine.isThisMachine && machine.hasRepo);
}

export function useCtoHome(active: boolean): CtoHomeState {
  const binding = useAppStore((state) => state.projectBinding);
  const scopeKey = useAppStore(selectActiveProjectStateKey);
  const { machines, thisMachineDeviceName, settled, connectedRemoteCount } = useProjectMachines(active);
  const { loaded: originLoaded, origin } = useRepoOrigin(binding);
  const keys = useMemo(
    () => ctoHomeStorageKeys({ gitOriginUrl: origin, binding }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [origin, binding?.key],
  );
  const storeKey = `${keys.accountScope ?? ""}|${keys.localKey ?? ""}`;
  const [storedRaw, setStored] = useState<StoredState>({ key: "", loaded: false, record: null, localOnly: false });
  const stored = useMemo<StoredState>(
    () => (storedRaw.key === storeKey
      ? storedRaw
      : { key: storeKey, loaded: false, record: null, localOnly: false }),
    [storeKey, storedRaw],
  );
  const readGeneration = useRef(0);

  // Read the choice whenever the tab (or its repo identity) changes, and again
  // each time the page becomes active, so a choice made on another machine
  // shows up without a restart.
  useEffect(() => {
    if (!active || !originLoaded) return;
    const generation = ++readGeneration.current;
    const local = readLocalCtoHome(keys.localKey);
    // Show the local copy at once; the account answer replaces it if it
    // differs. A repeat read for the same repository keeps what is on screen.
    setStored((current) => {
      if (current.key === storeKey && current.loaded) return current;
      return { key: storeKey, loaded: Boolean(local), record: local, localOnly: false };
    });
    void (async () => {
      let account = await readAccountCtoHome(keys.accountScope);
      // A machine that has not synced yet reads an empty cache. Ask the account
      // once before concluding that there is no choice at all.
      if (account.available && !account.value) {
        account = await readAccountCtoHome(keys.accountScope, { syncFirst: true });
      }
      if (generation !== readGeneration.current) return;
      if (account.available && account.value) {
        const record = account.value;
        if (!local || local.chosenAt !== record.chosenAt) {
          // Keep the offline copy in step with the account.
          await persistCtoHome({ accountScope: null, localKey: keys.localKey, record });
        }
        setStored({ key: storeKey, loaded: true, record, localOnly: false });
        return;
      }
      if (account.available && local) {
        // The account has no choice but this machine does (made while signed
        // out). Share it, so other machines agree.
        void persistCtoHome({ accountScope: keys.accountScope, localKey: keys.localKey, record: local });
      }
      setStored({ key: storeKey, loaded: true, record: local, localOnly: !account.available });
    })();
  }, [active, keys.accountScope, keys.localKey, originLoaded, storeKey]);

  const home = useMemo(
    () => (stored.record ? resolveCtoHomeMachine(stored.record, machines) : null),
    [machines, stored.record],
  );
  const suggested = useMemo(() => suggestCtoHomeMachine(machines), [machines]);

  const choose = useCallback(async (machine: ProjectMachine) => {
    // This computer is recorded by its account device id; without it no other
    // machine could ever find the CTO here, so the choice waits for it.
    if (machine.isThisMachine && !machine.deviceId) throw new Error(STILL_IDENTIFYING_THIS_COMPUTER);
    const record = ctoHomeRecordFor(machine, thisMachineDeviceName);
    readGeneration.current += 1;
    const { synced } = await persistCtoHome({ accountScope: keys.accountScope, localKey: keys.localKey, record });
    setStored({ key: storeKey, loaded: true, record, localOnly: !synced });
  }, [keys.accountScope, keys.localKey, storeKey, thisMachineDeviceName]);

  // One machine, and it is this one: nothing to choose between. The page runs
  // against the tab's binding straight away, and records This computer as home
  // once its device id is known, so a second machine added later still finds
  // the CTO where it has always been.
  const implicitThisMachine = settled && onlyThisMachine(machines, connectedRemoteCount);
  const thisMachine = machines.find((machine) => machine.isThisMachine) ?? null;
  const autoChoseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !stored.loaded || stored.record || !implicitThisMachine) return;
    if (!thisMachine?.deviceId || !thisMachine.hasRepo || !thisMachine.routable) return;
    const marker = `${storeKey}|${thisMachine.deviceId}`;
    if (autoChoseRef.current === marker) return;
    autoChoseRef.current = marker;
    void choose(thisMachine);
  }, [active, choose, implicitThisMachine, storeKey, stored.loaded, stored.record, thisMachine]);

  const state = useMemo<Omit<CtoHomeState, "choose">>(() => {
    const base = { machines, suggested, localOnly: stored.localOnly };
    if (!originLoaded || !stored.loaded) {
      return { ...base, status: "loading", pin: null, home: null, homeName: null, offlineReason: null };
    }
    const record = stored.record;
    if (!record) {
      if (!settled) {
        return { ...base, status: "loading", pin: null, home: null, homeName: null, offlineReason: null };
      }
      if (implicitThisMachine && thisMachine?.isActiveBinding) {
        // No other machine: the tab's own binding is the only possible home.
        return { ...base, status: "ready", pin: null, home: thisMachine, homeName: thisMachine.machineName, offlineReason: null };
      }
      return { ...base, status: "choose", pin: null, home: null, homeName: null, offlineReason: null };
    }
    const homeName = home && !home.isThisMachine ? home.machineName : (home?.machineName ?? record.name);
    if (!home) {
      if (!settled) return { ...base, status: "loading", pin: null, home: null, homeName, offlineReason: null };
      return {
        ...base,
        status: "offline",
        pin: null,
        home: null,
        homeName: record.name,
        offlineReason: `${record.name} isn't connected to this computer.`,
      };
    }
    if (!home.online) {
      return { ...base, status: "offline", pin: null, home, homeName, offlineReason: `${home.machineName} is offline.` };
    }
    if (!home.hasRepo || !home.routable) {
      return {
        ...base,
        status: "offline",
        pin: null,
        home,
        homeName,
        offlineReason: `${home.machineName} doesn't have this repository open right now.`,
      };
    }
    return { ...base, status: "ready", pin: home.pin, home, homeName, offlineReason: null };
  }, [home, implicitThisMachine, machines, originLoaded, settled, stored, suggested, thisMachine]);

  // Publish for surfaces outside this page (the capture gesture). Only a
  // concrete answer is published; "loading" clears it so a stale pin is never
  // reused across a tab switch.
  useEffect(() => {
    if (state.status === "ready") {
      rememberCtoHomeResolution(scopeKey, {
        status: "resolved",
        pin: state.pin,
        machineName: state.homeName ?? "",
        online: true,
      });
    } else if (state.status === "offline") {
      rememberCtoHomeResolution(scopeKey, { status: "unreachable", machineName: state.homeName ?? "" });
    } else {
      rememberCtoHomeResolution(scopeKey, null);
    }
  }, [scopeKey, state.homeName, state.pin, state.status]);

  return useMemo(() => ({ ...state, choose }), [choose, state]);
}

// ── Context for the CTO subtree ────────────────────────────────────────────

export type CtoHomeScope = {
  /** Pass to every CTO preload call. Null = the tab's binding. */
  pin: OpenProjectBinding | null;
  machineName: string | null;
  /** False until the home is resolved and reachable; calls must wait. */
  ready: boolean;
};

const FALLBACK_SCOPE: CtoHomeScope = { pin: null, machineName: null, ready: true };
const CtoHomeContext = createContext<CtoHomeScope | null>(null);

export function CtoHomeProvider({ scope, children }: { scope: CtoHomeScope; children: React.ReactNode }) {
  return <CtoHomeContext.Provider value={scope}>{children}</CtoHomeContext.Provider>;
}

/**
 * The CTO's machine for a component inside the CTO page. Outside the page
 * (tests, previews) it is the tab's binding.
 */
export function useCtoHomeScope(): CtoHomeScope {
  return useContext(CtoHomeContext) ?? FALLBACK_SCOPE;
}
