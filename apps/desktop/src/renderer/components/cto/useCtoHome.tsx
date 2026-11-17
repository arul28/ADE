import { adeCloudInstanceIdForMachine } from "../../state/adeCloudLaneIndex";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type CtoHomeMachineRecord,
} from "./ctoHomeMachine";
import { ctoHomeCloudInstanceId } from "../../../shared/ctoHomeMachine";
import type { CtoAdoptAccountCopyResult } from "../../../shared/ctoAccountCopy";

/**
 * Where this project's CTO lives, resolved for the CTO page.
 *
 * `status`:
 *  - `loading`  — the stored choice or the machine list is still arriving.
 *  - `choose`   — no home yet; show the first-run chooser. There is no
 *    default: even with one machine, the person picks it once.
 *  - `ready`    — `pin` addresses the home machine. It is never null when ready.
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
  /** True when the account store could not be reached: the choice is only local. */
  localOnly: boolean;
  /** The repository's git origin, or null when it has none (no ADE Cloud then). */
  origin: string | null;
  /** The ADE Cloud computer the home is, when it is one. */
  cloudInstanceId: string | null;
  /**
   * Records `machine` as the home, then has it take the CTO from the account
   * copy. Answers what it restored, or null when that machine's ADE can't.
   */
  choose: (machine: ProjectMachine, options?: { cloudInstanceId?: string | null }) => Promise<CtoAdoptAccountCopyResult | null>;
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

export function useCtoHome(active: boolean): CtoHomeState {
  const binding = useAppStore((state) => state.projectBinding);
  const scopeKey = useAppStore(selectActiveProjectStateKey);
  const { machines, thisMachineDeviceName, settled } = useProjectMachines(active);
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
  const choose = useCallback(async (
    machine: ProjectMachine,
    options?: { cloudInstanceId?: string | null },
  ): Promise<CtoAdoptAccountCopyResult | null> => {
    // This computer is recorded by its account device id; without it no other
    // machine could ever find the CTO here, so the choice waits for it.
    if (machine.isThisMachine && !machine.deviceId) throw new Error(STILL_IDENTIFYING_THIS_COMPUTER);
    if (!machine.pin) throw new Error(`${machine.machineName} can't be reached right now.`);
    const base = ctoHomeRecordFor(machine, thisMachineDeviceName);
    // An ADE Cloud computer picked from the list is one too: the record says
    // so, and every surface can wake it or make a new one later.
    const cloudInstanceId = options?.cloudInstanceId?.trim()
      || adeCloudInstanceIdForMachine({ hostname: machine.hostname, machineKey: machine.machineId })
      || null;
    const record: CtoHomeMachineRecord = cloudInstanceId ? { ...base, cloudInstanceId } : base;
    readGeneration.current += 1;
    const { synced } = await persistCtoHome({ accountScope: keys.accountScope, localKey: keys.localKey, record });
    // The new home takes the CTO from the account copy: its notes, identity,
    // routines and last turns, even when the old home is asleep or gone. The
    // record goes with it so that machine agrees before its next sync.
    let adopted: CtoAdoptAccountCopyResult | null = null;
    const adopt = window.ade?.cto?.adoptAccountCopy;
    if (adopt) {
      adopted = await adopt({ home: record }, machine.pin).catch(() => null);
    }
    setStored({ key: storeKey, loaded: true, record, localOnly: !synced });
    return adopted;
  }, [keys.accountScope, keys.localKey, storeKey, thisMachineDeviceName]);

  const state = useMemo<Omit<CtoHomeState, "choose">>(() => {
    const base = {
      machines,
      localOnly: stored.localOnly,
      origin,
      cloudInstanceId: ctoHomeCloudInstanceId(stored.record),
    };
    if (!originLoaded || !stored.loaded) {
      return { ...base, status: "loading", pin: null, home: null, homeName: null, offlineReason: null };
    }
    const record = stored.record;
    if (!record) {
      if (!settled) {
        return { ...base, status: "loading", pin: null, home: null, homeName: null, offlineReason: null };
      }
      return { ...base, status: "choose", pin: null, home: null, homeName: null, offlineReason: null };
    }
    // An ADE Cloud home reads "ADE Cloud", never its computer's own name.
    const recordName = base.cloudInstanceId ? ADE_CLOUD_NAME : record.name;
    const homeName = home && !home.isThisMachine ? home.machineName : (home?.machineName ?? recordName);
    if (!home) {
      if (!settled) return { ...base, status: "loading", pin: null, home: null, homeName, offlineReason: null };
      return {
        ...base,
        status: "offline",
        pin: null,
        home: null,
        homeName: recordName,
        offlineReason: `${recordName} isn't connected to this computer.`,
      };
    }
    if (!home.online) {
      return { ...base, status: "offline", pin: null, home, homeName, offlineReason: `${home.machineName} is offline.` };
    }
    if (!home.hasRepo || !home.routable || !home.pin) {
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
  }, [home, machines, origin, originLoaded, settled, stored]);

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
