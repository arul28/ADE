import { useCallback, useMemo, useRef, useState } from "react";
import {
  CLOUD_OUT_OF_HOURS_MESSAGE,
  cloudCatalogOf,
  cloudOutOfHours,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { useRootAppStore } from "../../state/appStore";
import { useAdeCloudLaneComputers, type AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import type { CloudSkylineLane } from "../remoteTargets/cloudBrand";

const NO_MACHINES: readonly CloudMachine[] = [];

/** The Run on menu's ADE Cloud entry. One entry for every ADE Cloud lane. */
export const ADE_CLOUD_MACHINE_ID = "__ade_cloud__";

/** What can open from the label above the box. Each opens Settings › ADE Cloud for now. */
export type AdeCloudTrayAction = "upgrade" | "free-space" | "settings";

/**
 * The label above the prompt box while ADE Cloud is picked and Send can't go:
 * `blocked` is a fact of the account (hours, computers, disk); `notice` is
 * something about this message the person can change (a file, a setting).
 */
export type AdeCloudTrayNotice = {
  tone: "blocked" | "notice";
  message: string;
  /** One short line for a narrow prompt box, so the label never wraps there. */
  short: string;
  actions: AdeCloudTrayAction[];
};

/**
 * Why the account can't start a new ADE Cloud lane now, or null. Unknown
 * (no account read yet) is never a block: the server still refuses and the
 * step card says why.
 */
export function adeCloudAccountBlock(
  account: CloudAccountState | null,
  options: { newLane: boolean },
): AdeCloudTrayNotice | null {
  if (!account) return null;
  const upgrade: AdeCloudTrayAction[] = account.rules === "free" ? ["upgrade"] : [];
  // A sleeping lane wakes on hours too, so this blocks every send.
  if (cloudOutOfHours(account) && !account.extraHours.enabled) {
    return { tone: "blocked", message: CLOUD_OUT_OF_HOURS_MESSAGE, short: "Out of ADE Cloud hours.", actions: upgrade.length ? upgrade : ["settings"] };
  }
  if (!options.newLane) return null;
  if (account.computers.limit > 0 && account.computers.total >= account.computers.limit) {
    const count = account.computers.limit;
    return {
      tone: "blocked",
      message: count === 1
        ? "You're using your one ADE Cloud computer."
        : `You're using all ${count} ADE Cloud computers.`,
      short: count === 1 ? "Your ADE Cloud computer is in use." : `All ${count} computers in use.`,
      actions: [...upgrade, "free-space"],
    };
  }
  if (account.disk.limitGb != null && account.disk.usedGb >= account.disk.limitGb) {
    return { tone: "blocked", message: "Your ADE Cloud disk space is full.", short: "ADE Cloud disk full.", actions: [...upgrade, "free-space"] };
  }
  return null;
}

/** Keeps one array identity while its signature does not change, so memos downstream hold. */
function useStableList<T>(list: T[], signatureOf: (item: T) => string): T[] {
  const ref = useRef<{ signature: string; list: T[] }>({ signature: "", list });
  const signature = list.map(signatureOf).join("\u0002");
  if (signature !== ref.current.signature) ref.current = { signature, list };
  return ref.current.list;
}

/**
 * Everything the composer needs for "Run on ADE Cloud", from data already in
 * memory: the account's computers (one shared read while the draft shows, see
 * `useCloudMachines`), the last list of lane computers (`adeCloudLaneIndex`)
 * until that read answers, and the saved default size. Nothing here reads on
 * a keystroke or on a menu open.
 */
export function useAdeCloudDraft({
  enabled,
  originUrl,
}: {
  /** The draft's launch controls show. */
  enabled: boolean;
  /** The tab project's git origin: which lanes on ADE Cloud are this project's. */
  originUrl: string | null;
}) {
  const cloudEnabled = useAdeCloudEnabled();
  const active = enabled && cloudEnabled;
  // No settle re-reads from here: the menu needs the list in memory, not a timer.
  const machines = useCloudMachines(active, { settle: false });
  const index = useAdeCloudLaneComputers();
  const result = machines.result?.state === "ok" ? machines.result : null;
  const account = result?.account ?? null;
  const origin = useMemo(() => normalizeGitRemoteIdentity(originUrl), [originUrl]);

  // The index is filled by the same read, and keeps the last list while a
  // new read runs: the Run on menu never waits on it.
  const computers = useStableList(
    index.computers.slice(),
    (computer) => `${computer.instanceId}:${computer.laneId}:${computer.laneName}:${computer.projectOrigin ?? ""}:${computer.state}`,
  );
  const skylineLanes = useMemo<CloudSkylineLane[]>(
    () => computers.map((computer) => ({ id: computer.instanceId, awake: computer.state === "running" })),
    [computers],
  );
  /** This project's lanes on ADE Cloud, by name. */
  const projectLanes = useMemo<AdeCloudLaneComputer[]>(
    () => (origin ? computers.filter((computer) => computer.projectOrigin === origin) : []),
    [computers, origin],
  );
  /** Account machine keys of lane computers: the Run on menu lists them under ADE Cloud, not as computers. */
  const laneMachineKeys = useMemo(
    () => new Set(computers.flatMap((computer) => (computer.machineKey ? [computer.machineKey] : []))),
    [computers],
  );

  const tiers = useMemo<CloudTier[]>(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const setDefaultTier = useRootAppStore((state) => state.setCloudDefaultTier);
  // The size for this draft. It follows the default until the person picks one.
  const [pickedTier, setPickedTier] = useState<CloudTierId | null>(null);
  const tierId: CloudTierId = (pickedTier && tiers.some((tier) => tier.id === pickedTier) ? pickedTier : null)
    ?? (tiers.some((tier) => tier.id === defaultTier) ? defaultTier : null)
    ?? tiers[0]?.id
    ?? defaultTier;
  const chooseTier = useCallback((next: CloudTierId) => setPickedTier(next), []);
  const resetTier = useCallback(() => setPickedTier(null), []);

  return {
    /** ADE Cloud access is on for this account: the Run on menu lists it. */
    available: cloudEnabled,
    account,
    /** The account's computers from the shared read (empty until it answers). */
    machines: result?.machines ?? NO_MACHINES,
    /** True once any read (or the saved copy) said which lanes exist. */
    lanesKnown: index.known,
    skylineLanes,
    projectLanes,
    laneMachineKeys,
    tiers,
    tierId,
    defaultTier,
    chooseTier,
    resetTier,
    setDefaultTier,
    refresh: machines.refresh,
  };
}

export type AdeCloudDraft = ReturnType<typeof useAdeCloudDraft>;
