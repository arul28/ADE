import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  cloudCatalogOf,
  cloudOutOfHours,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { cloudLaneLaunchStartRefusal, cloudLaneStartBlock } from "../../../shared/cloudLaneLaunch";
import type { AgentChatFileRef, ChatLaunchChatArgs, ChatLaunchLaneConfig, OpenProjectBinding } from "../../../shared/types";
import type { RemoteRuntimeConnectionStatus } from "../../../shared/types/remoteRuntime";
import { cloudTierHoursLeftLabel, cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { earnedHoursLeftMilli } from "../settings/cloudDashboard/cloudDashboardModel";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { isWebClientMode } from "../../lib/webClientMode";
import { useRootAppStore } from "../../state/appStore";
import { useAdeCloudLaneComputers, type AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import type { NewLaneDraftConfig } from "../lanes/CreateLaneDialogHost";
import { originUrlForBinding } from "../lanes/laneMachines";
import { settingsRouteFor } from "../settings/settingsManifest";
import { ADE_CLOUD_FREE_SPACE_ANCHOR, ADE_CLOUD_PLAN_ANCHOR, adeCloudSettingsRoute } from "../settings/settingsHash";
import { isAutoCreateLaneOptionId } from "../terminals/LaneCombobox";
import { AUTO_CREATE_DRAFT_LANE_OPTION as AUTO_CREATE_LANE_OPTION, type RoutedDraftLane } from "./useDraftMachineRouting";
import type { CloudSkylineLane } from "../remoteTargets/cloudBrand";

const NO_MACHINES: readonly CloudMachine[] = [];

/** The Run on menu's ADE Cloud entry. One entry for every ADE Cloud lane. */
export const ADE_CLOUD_MACHINE_ID = "__ade_cloud__";

/** What can open from the label above the box: the plan row, the Free up space flow, or the ADE Cloud page. */
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
  // One wording with `cloud.status` and the launch's early refusal.
  const block = cloudLaneStartBlock(account, options);
  if (!account || !block) return null;
  const upgrade: AdeCloudTrayAction[] = account.rules === "free" ? ["upgrade"] : [];
  const actions: AdeCloudTrayAction[] = block.code === "out_of_hours"
    ? (upgrade.length ? upgrade : ["settings"])
    : [...upgrade, "free-space"];
  return { tone: "blocked", message: block.message, short: block.short, actions };
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
  // Hours left now (the plan's and earned ones), and the Run on row's line: the
  // size a new lane gets and how long those hours last at it.
  const hoursLeftMilli = account ? account.hours.leftMilli + Math.max(0, earnedHoursLeftMilli(account) ?? 0) : null;
  const runOnLine = useMemo(() => {
    const tier = tiers.find((entry) => entry.id === tierId) ?? null;
    if (!account || !tier) return null;
    if (cloudOutOfHours(account) && hoursLeftMilli === 0) return `${tier.label} · no hours left`;
    return `${tier.label} · ${cloudTierHoursLeftLabel(tier, hoursLeftMilli ?? 0)} left at this size`;
  }, [account, hoursLeftMilli, tierId, tiers]);

  return {
    /**
     * ADE Cloud access is on for this account: the Run on menu lists it. Not
     * in the web app: making a lane's computer is the desktop app's.
     */
    available: cloudEnabled && !isWebClientMode(),
    account,
    /** The account's computers from the shared read (empty until it answers). */
    machines: result?.machines ?? NO_MACHINES,
    /** True once any read (or the saved copy) said which lanes exist. */
    lanesKnown: index.known,
    skylineLanes,
    projectLanes,
    /** The account's lane computers: the Run on menu lists them under ADE Cloud, not as computers. */
    computers,
    tiers,
    tierId,
    /** The size picked for this draft, or null while it follows the default (what a saved pick keeps). */
    pickedTier,
    defaultTier,
    chooseTier,
    resetTier,
    setDefaultTier,
    hoursLeftMilli,
    runOnLine,
    refresh: machines.refresh,
  };
}

export type AdeCloudDraft = ReturnType<typeof useAdeCloudDraft>;

/** What a send to ADE Cloud needs, written each render by `useAdeCloudComposer` (the pane's send callback is defined earlier). */
export type AdeCloudSend = {
  tierId: string;
  originUrl: string | null;
  tabBinding: OpenProjectBinding | null;
  /** The ADE Cloud lane picked, or null for a new lane. */
  lane: AdeCloudLaneComputer | null;
  /** Set while Send is off; the send never starts then. */
  notice: AdeCloudTrayNotice | null;
  connections: readonly RemoteRuntimeConnectionStatus[];
};

/**
 * The composer's ADE Cloud pick, derived each render from the draft's Run on
 * state: the lane list, the picked lane, the label above the box (why Send
 * can't go), what Send needs (`sendRef`), and where the label's actions open.
 */
export function useAdeCloudComposer(input: {
  draft: ReturnType<typeof useAdeCloudDraft>;
  mode: boolean;
  laneId: string | null;
  setLaneId: (laneId: string | null) => void;
  showControls: boolean;
  parallelChatMode: boolean;
  isCliDraft: boolean;
  attachments: AgentChatFileRef[];
  newLaneConfig: NewLaneDraftConfig | null;
  /** Stable (module level): the launch's lane config from the "+" lane's draft. */
  laneConfigOf: (config: NewLaneDraftConfig) => ChatLaunchLaneConfig;
  selectorLanes: readonly RoutedDraftLane[];
  tabBinding: OpenProjectBinding | null;
  connections: readonly RemoteRuntimeConnectionStatus[];
  sendRef: MutableRefObject<AdeCloudSend | null>;
  navigate: (to: string) => void;
}) {
  const { draft, mode, laneId, setLaneId, navigate } = input;
  /**
   * The lane list with ADE Cloud picked: Auto-create lane first (or the "+"
   * lane's name), then this project's lanes on ADE Cloud by name, read from
   * the computers' metadata with no wake. No Primary: ADE Cloud has none.
   */
  const shelfLanes = useMemo<RoutedDraftLane[]>(() => {
    const autoRow = input.selectorLanes.find((lane) => isAutoCreateLaneOptionId(lane.id))
      ?? (AUTO_CREATE_LANE_OPTION as RoutedDraftLane);
    return [
      input.newLaneConfig ? { ...autoRow, name: input.newLaneConfig.name, detail: "New" } : { ...autoRow, detail: null },
      ...draft.projectLanes.map((lane) => ({ id: lane.laneId, name: lane.laneName } as RoutedDraftLane)),
    ];
  }, [draft.projectLanes, input.selectorLanes, input.newLaneConfig]);
  const selectedLane = laneId
    ? draft.projectLanes.find((lane) => lane.laneId === laneId) ?? null
    : null;
  // A lane that went away (deleted elsewhere) falls back to a new lane.
  useEffect(() => {
    if (laneId && draft.lanesKnown && !selectedLane) setLaneId(null);
  }, [draft.lanesKnown, laneId, selectedLane, setLaneId]);
  const newLane = mode && !selectedLane;
  const originUrl = originUrlForBinding(input.tabBinding);
  /**
   * Why Send can't go to ADE Cloud now, shown above the box before Send:
   * a fact of the account (out of hours, all computers in use, disk full) or
   * a start refusal the composer can already see (a local file, an
   * "uncommitted" start, no GitHub origin, parallel models). A CLI draft
   * runs there: its lane is set up, then this window starts the CLI session
   * on the new computer.
   * The same sentences main would refuse with, so none appears after Send.
   */
  const notice = useMemo<AdeCloudTrayNotice | null>(() => {
    if (!mode || !input.showControls) return null;
    // One rule for every start refusal, new lane or existing lane: while the
    // pick can't run this draft, the label says why and Send is off. The pick
    // stays, so switching back (to one model, to a chat) runs it again.
    if (input.parallelChatMode) {
      return {
        tone: "notice",
        message: "Parallel models runs on this computer. Pick This computer to use it.",
        short: "Parallel models runs here only.",
        actions: [],
      };
    }
    const accountBlock = adeCloudAccountBlock(draft.account, { newLane });
    if (accountBlock) return accountBlock;
    if (!newLane) return null;
    const problem = cloudLaneLaunchStartRefusal({
      args: {
        kind: input.isCliDraft ? "cli" : "chat",
        mode: "foreground",
        launchId: "",
        prompt: "",
        attachments: input.attachments,
        cloud: { sizeId: draft.tierId },
        ...(input.newLaneConfig ? { laneConfig: input.laneConfigOf(input.newLaneConfig) } : {}),
        ...(input.isCliDraft ? {} : { chat: { create: {} as ChatLaunchChatArgs["create"], message: { text: "", attachments: input.attachments } } }),
      },
      originUrl,
    });
    return problem ? { tone: "notice", message: problem.message, short: problem.short, actions: [] } : null;
  }, [
    draft.account,
    draft.tierId,
    mode,
    newLane,
    originUrl,
    input.attachments,
    input.newLaneConfig,
    input.laneConfigOf,
    input.isCliDraft,
    input.parallelChatMode,
    input.showControls,
  ]);
  input.sendRef.current = mode
    ? {
        tierId: draft.tierId,
        originUrl,
        tabBinding: input.tabBinding,
        lane: selectedLane,
        notice,
        connections: input.connections,
      }
    : null;
  const openSettings = useCallback((action: AdeCloudTrayAction) => {
    // Settings › ADE Cloud, opened where the action is: "Upgrade" on the Plan
    // and billing row, "Free up space" with the dashboard's flow already open.
    navigate(action === "upgrade"
      ? adeCloudSettingsRoute(ADE_CLOUD_PLAN_ANCHOR)
      : action === "free-space"
        ? adeCloudSettingsRoute(ADE_CLOUD_FREE_SPACE_ANCHOR)
        : settingsRouteFor("integrations.ade-cloud"));
  }, [navigate]);

  return { shelfLanes, selectedLane, newLane, notice, openSettings };
}
