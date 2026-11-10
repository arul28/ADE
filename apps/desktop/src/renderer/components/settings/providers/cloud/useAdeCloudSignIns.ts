/**
 * The reads behind the ADE Cloud place of Settings › Providers.
 *
 * Two sources, each through its own pin:
 *  - the account part (`providerLogins.status`) through This computer's pin,
 *    so the Keychain state is the Mac in front of the person;
 *  - the cloud part (`providerLogins.status` and `ai.getStatus`) through the
 *    reporting cloud computer's pin.
 *
 * The account part draws the tiles at once; the cloud part fills in when it
 * answers. Reads run on open, on `providerLogins.onChanged` and on Re-check.
 * No timer and no poll. Every effect keys on a pin's key, and a result that
 * arrives for an old key is dropped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import type { AiSettingsStatus, OpenProjectBinding } from "../../../../../shared/types";
import type { ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { withMachineTimeout, type ProjectMachine } from "../../../../state/projectMachines";
import { cloudBoxForMachine } from "../../../remoteTargets/cloudMachineModel";
import { useCloudMachines } from "../../../remoteTargets/useCloudMachines";
import { useSettingsMachines } from "../../machines/settingsMachinesContext";
import type { AdeCloudAccountPart, AdeCloudCloudPart } from "./adeCloudSignInModel";

export type AdeCloudSignInsState = {
  account: AdeCloudAccountPart;
  cloud: AdeCloudCloudPart;
  saved: CloudSignInStatus["saved"] | null;
  /** The cloud computers that can report, the reporting one first. */
  candidates: readonly ProjectMachine[];
  reporting: ProjectMachine | null;
  pickReporting: (machineId: string) => void;
  /** This computer's pin (null: the tab is bound here, or it cannot be reached). Writes go here. */
  accountPin: OpenProjectBinding | null;
  /** The account read reaches the Mac in front of the person. */
  keychainIsThisMac: boolean;
  recheck: () => Promise<void>;
  rechecking: boolean;
  /** A write's returned status replaces the account part (the write and its read reach one brain). */
  applyAccountStatus: (status: ProviderLoginStatus) => void;
  /** A saved key write's returned status replaces the saved list. */
  applySaved: (status: CloudSignInStatus | null | undefined) => void;
  /** Read the reporting computer's AI status again (after a sign-in there). */
  refreshCloudAi: () => void;
};

/** The connection target id behind a remote machine, for its account machine key. */
function targetIdOf(machine: ProjectMachine): string | null {
  const binding = machine.binding;
  return binding?.kind === "remote" ? binding.targetId : null;
}

/** A cloud computer's pin key, stable while the machine and its binding are. */
function reportingKey(machine: ProjectMachine | null): string | null {
  return machine ? `${machine.machineId}|${machine.pin?.key ?? "bound"}` : null;
}

export function useAdeCloudSignIns(): AdeCloudSignInsState {
  const { machines } = useSettingsMachines();
  const thisMachine = machines.find((machine) => machine.isThisMachine) ?? null;
  // When This computer cannot be reached, the read goes unpinned: the account
  // fields are still right, but the Keychain state is the bound machine's.
  const keychainIsThisMac = thisMachine?.routable === true;
  const accountPin = keychainIsThisMac ? thisMachine!.pin : null;
  const accountKey = accountPin?.key ?? null;
  const accountPinRef = useRef(accountPin);
  accountPinRef.current = accountPin;

  // ── Which machines are cloud computers ──
  const { result: cloudResult, refresh: refreshCloudMachines } = useCloudMachines(true);
  const [machineKeys, setMachineKeys] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void window.ade?.remoteRuntime?.listTargets?.().then(
      (targets) => {
        if (cancelled) return;
        const keys = new Map<string, string>();
        for (const target of targets) {
          const key = target.pairedMachine?.machineKey?.trim();
          if (key) keys.set(target.id, key);
        }
        setMachineKeys(keys);
      },
      (error: unknown) => console.warn("[providers] reading connection targets failed", error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = useMemo(() => {
    const boxes = cloudResult?.state === "ok" ? cloudResult.machines : [];
    if (boxes.length === 0) return [];
    return machines
      .filter((machine) => !machine.isThisMachine && machine.routable && machine.online)
      .filter((machine) => {
        const targetId = targetIdOf(machine);
        return cloudBoxForMachine(boxes, {
          machineKey: targetId ? machineKeys.get(targetId) ?? null : null,
          hostname: machine.hostname,
        }) != null;
      })
      .sort((a, b) => Number(b.isActiveBinding) - Number(a.isActiveBinding) || a.machineName.localeCompare(b.machineName));
  }, [cloudResult, machineKeys, machines]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const reporting = candidates.find((machine) => machine.machineId === pickedId) ?? candidates[0] ?? null;
  const cloudKey = reportingKey(reporting);
  const reportingRef = useRef(reporting);
  reportingRef.current = reporting;

  // ── Reads ──
  const [account, setAccount] = useState<AdeCloudAccountPart>({ state: "loading" });
  const [cloudStatus, setCloudStatus] = useState<{ key: string; status: ProviderLoginStatus | null; failed: boolean } | null>(null);
  const [cloudAi, setCloudAi] = useState<{ key: string; ai: AiSettingsStatus | null } | null>(null);
  const [saved, setSaved] = useState<CloudSignInStatus["saved"] | null>(null);
  // Bumped by `providerLogins.onChanged` and Re-check: both status reads run again.
  const [statusTick, setStatusTick] = useState(0);
  // Bumped by Re-check and on open only: the AI read is the heavier one.
  const [aiTick, setAiTick] = useState(0);

  useEffect(() => {
    const off = window.ade?.providerLogins?.onChanged?.(() => setStatusTick((tick) => tick + 1));
    return () => off?.();
  }, []);

  /** One account read; `stale()` drops a result that arrives too late. */
  const readAccount = useCallback(async (stale: () => boolean) => {
    const read = window.ade?.providerLogins?.status;
    if (typeof read !== "function") {
      setAccount({ state: "failed" });
      return;
    }
    try {
      const status = await read({}, accountPinRef.current);
      if (!stale()) setAccount({ state: "ok", status });
    } catch (error) {
      console.warn("[providers] reading ADE Cloud sign-ins failed", error);
      if (!stale()) setAccount((current) => (current.state === "ok" ? current : { state: "failed" }));
    }
  }, []);

  /** One status read on the reporting cloud computer, kept under its pin key. */
  const readCloudStatus = useCallback(async (machine: ProjectMachine, key: string, stale: () => boolean) => {
    const read = window.ade?.providerLogins?.status;
    if (typeof read !== "function") return;
    try {
      const status = await withMachineTimeout(read({}, machine.pin), machine.machineName);
      if (!stale()) setCloudStatus({ key, status, failed: false });
    } catch (error) {
      console.warn("[providers] reading the cloud computer's sign-ins failed", error);
      if (!stale()) setCloudStatus({ key, status: null, failed: true });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readAccount(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [accountKey, readAccount, statusTick]);

  useEffect(() => {
    let cancelled = false;
    const readSaved = () => {
      void window.ade?.cloud?.cloudSignInStatus?.().then(
        (status) => {
          if (!cancelled) setSaved(status && !status.unknown ? status.saved : null);
        },
        () => undefined,
      );
    };
    readSaved();
    const off = window.ade?.cloud?.onCloudSignInChanged?.(readSaved);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    const machine = reportingRef.current;
    if (!cloudKey || !machine) return undefined;
    let cancelled = false;
    void readCloudStatus(machine, cloudKey, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [cloudKey, readCloudStatus, statusTick]);

  useEffect(() => {
    const machine = reportingRef.current;
    if (!cloudKey || !machine) return undefined;
    let cancelled = false;
    const read = window.ade?.ai?.getStatus;
    if (typeof read !== "function") return undefined;
    void withMachineTimeout(read({}, machine.pin), machine.machineName).then(
      (ai) => {
        if (!cancelled) setCloudAi({ key: cloudKey, ai });
      },
      (error: unknown) => {
        console.warn("[providers] reading the cloud computer's AI status failed", error);
        if (!cancelled) setCloudAi({ key: cloudKey, ai: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [aiTick, cloudKey]);

  const cloud = useMemo<AdeCloudCloudPart>(() => {
    if (!cloudResult) return { state: "unknown" };
    if (cloudResult.state === "ok" && (cloudResult.instanceCount ?? cloudResult.machines.length) === 0) return { state: "no_computer" };
    if (!reporting || !cloudKey) {
      if (cloudResult.state !== "ok") return { state: "unknown" };
      // Asleep only when no box is awake. An awake box that is not a machine
      // this project reaches (not connected here, or not set up for this repo)
      // is a different case, and the page says so.
      const boxes = cloudResult.machines;
      const awake = boxes.length === 0 || boxes.some((box) => box.state === "running" || box.state === "starting");
      return { state: awake ? "unreachable" : "none_awake" };
    }
    const computerName = reporting.machineName;
    // Only results for the computer shown now count.
    const status = cloudStatus?.key === cloudKey ? cloudStatus : null;
    if (!status) return { state: "loading", computerName };
    if (status.failed || !status.status || !status.status.thisComputer.cloudComputer) return { state: "no_answer", computerName };
    const ai = cloudAi?.key === cloudKey ? cloudAi.ai : null;
    return { state: "ok", computerName, status: status.status, ai };
  }, [cloudAi, cloudKey, cloudResult, cloudStatus, reporting]);

  // ── Re-check ──
  const [rechecking, setRechecking] = useState(false);
  const recheckingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /**
   * Re-check: a pass on the reporting computer, then both status reads, and
   * it resolves once they landed. The view sorts its tiles again then (and
   * only then, after the first reads): a switch or a change event never
   * moves a tile.
   */
  const recheck = useCallback(async () => {
    if (recheckingRef.current) return;
    recheckingRef.current = true;
    setRechecking(true);
    const machine = reportingRef.current;
    const key = reportingKey(machine);
    const accountKeyAtStart = accountPinRef.current?.key ?? null;
    const stale = () => !mountedRef.current;
    try {
      const capture = window.ade?.providerLogins?.captureNow;
      // A pass on the reporting computer: it pulls the account's sign-ins and applies them.
      if (machine && typeof capture === "function") {
        await withMachineTimeout(capture({}, machine.pin), machine.machineName).catch((error: unknown) => {
          console.warn("[providers] Re-check on the cloud computer failed", error);
        });
      }
      await Promise.all([
        readAccount(() => stale() || (accountPinRef.current?.key ?? null) !== accountKeyAtStart),
        machine && key ? readCloudStatus(machine, key, () => stale() || reportingKey(reportingRef.current) !== key) : null,
      ]);
    } finally {
      recheckingRef.current = false;
      if (mountedRef.current) {
        setRechecking(false);
        refreshCloudMachines();
        setAiTick((tick) => tick + 1);
      }
    }
  }, [readAccount, readCloudStatus, refreshCloudMachines]);

  const applyAccountStatus = useCallback((status: ProviderLoginStatus) => {
    setAccount({ state: "ok", status });
  }, []);
  const applySaved = useCallback((status: CloudSignInStatus | null | undefined) => {
    if (status && !status.unknown) setSaved(status.saved);
  }, []);
  const refreshCloudAi = useCallback(() => setAiTick((tick) => tick + 1), []);

  return {
    account,
    cloud,
    saved,
    candidates,
    reporting,
    pickReporting: setPickedId,
    accountPin,
    keychainIsThisMac,
    recheck,
    rechecking,
    applyAccountStatus,
    applySaved,
    refreshCloudAi,
  };
}
