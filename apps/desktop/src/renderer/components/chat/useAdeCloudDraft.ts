import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import { captureError } from "../../../shared/sentry/capture";
import {
  cloudCatalogOf,
  cloudHoursLeftMilli,
  cloudOutOfHours,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { cloudLaneLaunchStartRefusal, cloudLaneStartBlock } from "../../../shared/cloudLaneLaunch";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";
import type { AgentChatFileRef, AgentChatProvider, ChatLaunchChatArgs, ChatLaunchLaneConfig, OpenProjectBinding } from "../../../shared/types";
import type { RemoteRuntimeConnectionStatus } from "../../../shared/types/remoteRuntime";
import { cloudTierHoursAt, cloudTiers, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { adeCloudDoBlock, useAdeCloudAccess, useAdeCloudEnabled } from "../../state/cloudAccess";
import { isWebClientMode } from "../../lib/webClientMode";
import { accountCloudLaunchesAvailable } from "../../state/accountCloudLaunches";
import { cloudRemoteSignInOf, cloudRemoteSignInRefusal } from "../../../shared/accountCloudLaunches";
import { useRootAppStore } from "../../state/appStore";
import { pickCloudDefaultTier } from "../../lib/cloudDefaultTier";
import { useAdeCloudLaneComputers, type AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import type { NewLaneDraftConfig } from "../lanes/CreateLaneDialogHost";
import { originUrlForBinding, projectOriginMemoryVersion, subscribeProjectOriginMemory } from "../lanes/laneMachines";
import { settingsRouteFor } from "../settings/settingsManifest";
import { ADE_CLOUD_FREE_SPACE_ANCHOR, ADE_CLOUD_PLAN_ANCHOR, adeCloudSettingsRoute } from "../settings/settingsHash";
import { isAutoCreateLaneOptionId } from "../terminals/LaneCombobox";
import { AUTO_CREATE_DRAFT_LANE_OPTION as AUTO_CREATE_LANE_OPTION, type RoutedDraftLane } from "./useDraftMachineRouting";

const NO_MACHINES: readonly CloudMachine[] = [];

/** The Run on menu's ADE Cloud entry. One entry for every ADE Cloud lane. */
import { ADE_CLOUD_MACHINE_ID } from "../../../shared/adeCloudMachine";
export { ADE_CLOUD_MACHINE_ID };

/** What can open from the label above the box: the plan row, the Free up space flow, the ADE Cloud page, or GitHub's settings. */
export type AdeCloudTrayAction = "upgrade" | "free-space" | "settings" | "github";

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
  const access = useAdeCloudAccess();
  // Reading the account's computers needs the account to be allowed in; a
  // blocked account still sees the entry, read-only, with the server's sentence.
  const active = enabled && cloudEnabled && access.state !== "blocked";
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
  /** This project's lanes on ADE Cloud, by name. */
  const projectLanes = useMemo<AdeCloudLaneComputer[]>(
    () => (origin ? computers.filter((computer) => computer.projectOrigin === origin) : []),
    [computers, origin],
  );

  const tiers = useMemo<CloudTier[]>(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const setDefaultTier = pickCloudDefaultTier;
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
  const hoursLeftMilli = account ? cloudHoursLeftMilli(account) : null;
  const runOnLine = useMemo(() => {
    const tier = tiers.find((entry) => entry.id === tierId) ?? null;
    if (!account || !tier) return null;
    if (cloudOutOfHours(account) && hoursLeftMilli === 0) return `${tier.label} · no hours left`;
    return `${tier.label} · ${cloudTierHoursAt(tier, hoursLeftMilli ?? 0)} left at this size`;
  }, [account, hoursLeftMilli, tierId, tiers]);

  return {
    /**
     * ADE Cloud is one machine every account has: the Run on menu always
     * lists it (also before the server answers). ADE Web starts the lane
     * through the account server (`POST /cloud/launches`).
     */
    available: true,
    /**
     * Why ADE Cloud can't start or wake anything from here, or null: the
     * account is blocked (the server's sentence), ADE is signed out, or ADE
     * Web has no account sign-in in this browser. The entry still shows, off.
     */
    doBlock: adeCloudDoBlock(access)
      ?? (isWebClientMode() && !accountCloudLaunchesAvailable() ? "Sign in to ADE in this browser to use ADE Cloud." : null),
    account,
    /** The account's computers from the shared read (empty until it answers). */
    machines: result?.machines ?? NO_MACHINES,
    /** True once any read (or the saved copy) said which lanes exist. */
    lanesKnown: index.known,
    projectLanes,
    /** The account's lane computers: the Run on menu lists them under ADE Cloud, not as computers. */
    computers,
    /** Every ADE Cloud computer of the account (`isAdeCloudComputer`), a lane's or not. */
    index,
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
  /** `default` while the size follows the default (nobody picked one): a Small may move to Medium when its setup needs more memory. */
  sizeChoice: "default" | "picked";
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
/**
 * Antigravity on ADE Cloud uses the Google sign-in ADE carries from a
 * person's own computer. Without it a computer would wait for a browser
 * sign-in it can't do.
 */
export const ANTIGRAVITY_NOT_CARRIED_SENTENCE =
  "Sign in to Antigravity in ADE on your computer once (Allow the Keychain or Credential Manager if asked). ADE Cloud then uses that sign-in.";

/**
 * Whether the account carries an Antigravity sign-in to ADE Cloud: true,
 * false, or null while unknown (no answer yet, or a server that doesn't say).
 * Read once when Antigravity is picked with ADE Cloud, and again on window
 * focus (a sign-in on the computer, then back here). No timer. Account level,
 * so no pin.
 */
function useAntigravityCarried(wanted: boolean): boolean | null {
  const [carried, setCarried] = useState<boolean | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let cancelled = false;
    const read = () => {
      const desktopRead = window.ade?.cloud?.carriedSignIns;
      // ADE Web reads the account's sign-ins; the server adds `carried` there.
      const webRead = window.ade?.cloudLaunches?.signIns;
      const answer: Promise<{ antigravity?: boolean } | null | undefined> = desktopRead
        ? desktopRead()
        : webRead
          ? webRead().then((signIns) => (signIns as { carried?: { antigravity?: boolean } }).carried ?? null)
          : Promise.resolve(null);
      void answer.then(
        (value) => {
          if (!cancelled) setCarried(typeof value?.antigravity === "boolean" ? value.antigravity : null);
        },
        // Unknown stays unknown; the next focus reads again.
        (error: unknown) => {
          captureError(error, { level: "warning", handled: true, fingerprint: ["ade-cloud", "carried-sign-ins-read"] });
        },
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [wanted]);
  return wanted ? carried : null;
}

export function useAdeCloudComposer(input: {
  draft: ReturnType<typeof useAdeCloudDraft>;
  mode: boolean;
  laneId: string | null;
  setLaneId: (laneId: string | null) => void;
  showControls: boolean;
  parallelChatMode: boolean;
  isCliDraft: boolean;
  /** The draft chat's provider: ADE Web can't start one that signs in only from the desktop. */
  provider: AgentChatProvider | null;
  attachments: AgentChatFileRef[];
  newLaneConfig: NewLaneDraftConfig | null;
  /** Stable (module level): the launch's lane config from the "+" lane's draft. */
  laneConfigOf: (config: NewLaneDraftConfig) => ChatLaunchLaneConfig;
  selectorLanes: readonly RoutedDraftLane[];
  tabBinding: OpenProjectBinding | null;
  connections: readonly RemoteRuntimeConnectionStatus[];
  sendRef: MutableRefObject<AdeCloudSend | null>;
  navigate: (to: string) => void;
  /** Whether the composer is on screen (the Work tab shown and its tile visible); coming back re-reads a refusal. */
  visible: boolean;
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
  // The origin of a local tab comes from the recent projects read, which can
  // land after this renders (a project just cloned or opened): read it again
  // when that memory changes, or "no GitHub origin" stays on Send.
  useSyncExternalStore(subscribeProjectOriginMemory, projectOriginMemoryVersion, projectOriginMemoryVersion);
  const originUrl = originUrlForBinding(input.tabBinding);
  // Can a new computer clone this repository with the account's credentials?
  // Asked before Send (account-level, no pin), once per repository, so a
  // private repository with no git credential that follows the account is a
  // label here, never a failed "Clone repository" step after the computer was
  // made (C4, beta.12 #15). Asked again when GitHub's connection changes
  // (main tells again once the account's copy is written), and while it
  // refuses, when the composer comes back into view (back from Settings, the
  // tile shown again), on window focus and on a blocked Send: the Work tab
  // stays mounted while the person connects GitHub in Settings.
  const [gitPreflight, setGitPreflight] = useState<{ originUrl: string; result: CloudGitPreflight | null } | null>(null);
  const [gitPreflightRead, setGitPreflightRead] = useState(0);
  const preflightWanted = mode && newLane && input.showControls && Boolean(originUrl);
  useEffect(() => {
    if (!preflightWanted || !originUrl) return undefined;
    const read = window.ade?.cloud?.gitPreflight;
    if (typeof read !== "function") return undefined;
    let cancelled = false;
    void read({ originUrl }).then(
      (result) => {
        if (!cancelled) setGitPreflight({ originUrl, result });
      },
      (error: unknown) => {
        // Unknown is never a block: the launch's own check still says why.
        console.warn("[chat] ADE Cloud git preflight failed", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gitPreflightRead, originUrl, preflightWanted]);
  const gitRefusal = gitPreflight && gitPreflight.originUrl === originUrl && gitPreflight.result && !gitPreflight.result.ok
    ? gitPreflight.result
    : null;
  const recheckGitPreflight = useCallback(() => setGitPreflightRead((count) => count + 1), []);
  useEffect(() => {
    if (!preflightWanted) return undefined;
    return window.ade?.github?.onStatusChanged?.(() => recheckGitPreflight()) ?? undefined;
  }, [preflightWanted, recheckGitPreflight]);
  const refusedNow = gitRefusal != null;
  useEffect(() => {
    if (!preflightWanted || !refusedNow) return undefined;
    window.addEventListener("focus", recheckGitPreflight);
    return () => window.removeEventListener("focus", recheckGitPreflight);
  }, [preflightWanted, recheckGitPreflight, refusedNow]);
  // Back from Settings is a route change (no window focus): the parked Work
  // surface's tile turns visible again, and that re-reads while a refusal
  // holds Send. So does a hidden tile shown again.
  const visible = input.visible;
  const wasVisible = useRef(visible);
  useEffect(() => {
    const cameBack = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (cameBack && preflightWanted && refusedNow) recheckGitPreflight();
  }, [preflightWanted, recheckGitPreflight, refusedNow, visible]);
  /**
   * Why Send can't go to ADE Cloud now, shown above the box before Send:
   * a fact of the account (out of hours, all computers in use, disk full) or
   * a start refusal the composer can already see (a local file, an
   * "uncommitted" start, no GitHub origin, parallel models). A CLI draft
   * runs there: its lane is set up, then this window starts the CLI session
   * on the new computer.
   * The same sentences main would refuse with, so none appears after Send.
   */
  const antigravityCarried = useAntigravityCarried(Boolean(mode && input.showControls && !input.isCliDraft && input.provider === "antigravity"));
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
    // Blocked or signed out: nothing can start or wake; reading still works.
    if (draft.doBlock) {
      return { tone: "blocked", message: draft.doBlock, short: "ADE Cloud can't start work now.", actions: [] };
    }
    const accountBlock = adeCloudAccountBlock(draft.account, { newLane });
    if (accountBlock) return accountBlock;
    // Antigravity runs on the sign-in the account carries from a computer of
    // the person's own. Known not carried, say how; on the web, also while
    // unknown (it can't carry one itself).
    if (!input.isCliDraft && input.provider === "antigravity" && (antigravityCarried === false || (antigravityCarried == null && isWebClientMode()))) {
      return {
        tone: "notice",
        message: ANTIGRAVITY_NOT_CARRIED_SENTENCE,
        short: "Sign in to Antigravity on your computer first.",
        actions: [],
      };
    }
    if (!newLane) return null;
    // ADE Web starts a new lane through the account server, which takes a
    // chat and its message. A CLI session needs a terminal on the new
    // computer, and files go up with the desktop's launch.
    if (isWebClientMode() && input.isCliDraft) {
      return {
        tone: "notice",
        message: "A CLI session on ADE Cloud starts from the ADE desktop app. Send a chat here, or pick one of your computers.",
        short: "CLI on ADE Cloud: desktop app only.",
        actions: [],
      };
    }
    // The account server can't finish a sign-in that runs only on the desktop:
    // the computer would wait on it until it gives up. Antigravity has its own
    // rule above (the carried sign-in).
    const remoteSignIn = isWebClientMode() && !input.isCliDraft && input.provider !== "antigravity" ? cloudRemoteSignInOf(input.provider) : null;
    if (remoteSignIn?.remoteSignIn === "desktop") {
      return {
        tone: "notice",
        message: cloudRemoteSignInRefusal(remoteSignIn),
        short: `${remoteSignIn.label} on ADE Cloud: desktop app only.`,
        actions: [],
      };
    }
    if (isWebClientMode() && input.attachments.length > 0) {
      return {
        tone: "notice",
        message: "Files go to a new ADE Cloud lane from the ADE desktop app. Remove them to send this chat from here.",
        short: "Remove the files to send here.",
        actions: [],
      };
    }
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
    if (problem) return { tone: "notice", message: problem.message, short: problem.short, actions: [] };
    if (gitRefusal) {
      return {
        tone: "blocked",
        message: gitRefusal.message,
        short: "Connect GitHub to clone this repository.",
        actions: ["github"],
      };
    }
    return null;
  }, [
    antigravityCarried,
    draft.account,
    draft.doBlock,
    gitRefusal,
    draft.tierId,
    mode,
    newLane,
    originUrl,
    input.attachments,
    input.newLaneConfig,
    input.laneConfigOf,
    input.isCliDraft,
    input.parallelChatMode,
    input.provider,
    input.showControls,
  ]);
  input.sendRef.current = mode
    ? {
        tierId: draft.tierId,
        sizeChoice: draft.pickedTier ? "picked" : "default",
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
        : action === "github"
          ? settingsRouteFor("integrations.github")
          : settingsRouteFor("integrations.ade-cloud"));
  }, [navigate]);

  /** A blocked Send: ask GitHub again when its refusal is what holds Send. */
  const recheckSendBlock = useCallback(() => {
    if (refusedNow) recheckGitPreflight();
  }, [recheckGitPreflight, refusedNow]);

  return { shelfLanes, selectedLane, newLane, notice, openSettings, recheckSendBlock };
}
