import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { GitHubStatus, LaneSummary, OpenProjectBinding, UsageSnapshot } from "../../../../shared/types";
import type { AttentionItem } from "../../../../shared/types/attention";
import { isProviderInstanceProvider } from "../../../../shared/types/providerInstances";
import { countActivityBoardColumns } from "../../../../shared/attention/activityBoardColumn";
import { selectActiveProjectStateKey, useAppStore, workViewStoreForProject } from "../../../state/appStore";
import { useActivityStore } from "../../../state/activityStore";
import { useProjectMachines } from "../../../state/projectMachines";
import { activityFeedItems } from "../../activity/activityPriority";
import { useUsageSnapshot } from "../../usage/useUsageSnapshot";
import { usageLeftLevel } from "../../usage/usageDesign";
import { humanizeProvider } from "../../usage/usageProviderNames";
import { formatResetIn, windowLabel } from "../../usage/usageWindowFormat";
import { settingsRouteFor } from "../../settings/settingsManifest";
import { loadJiraConnectionStatus } from "../../issues/jiraIssueStore";
import { openConnectionsPanel } from "../../../lib/connectionsPanel";
import { openStartChatDraft } from "../../../lib/workDraft";
import { readOnboardingProgress } from "../../../onboarding/onboardingProgress";
import { forgetPostponedSuggestion, registerSuggestionStarter } from "../../../onboarding/adeTipsSuggestions";
import { isSuggestionOff, markSuggestionDone } from "../../../onboarding/situationalSuggestions";
import { useChatSendSignals, type IssueTracker } from "./chatSendSignals";
import { useSituationalSuggestion } from "./useSituationalSuggestion";
import { useFeatureTipCard } from "./useFeatureTipCard";

/**
 * The situational suggestions' signals (tier 3 of onboarding), each a small
 * hook that reads data the shell already has or an event that already fires.
 * Nothing here polls or adds IPC on a hot path: the usage snapshot and the
 * machine list are push feeds other surfaces already hold, Activity is synced
 * by the shell, and the few reads (a tracker's connection, the paired phones)
 * run once, only after their signal is otherwise there. The send-time signals
 * come from `noteChatSendForSuggestions` (`chatSendSignals.ts`).
 *
 * Renders nothing; a component of its own so its updates never re-render the
 * shell. `useSituationalSuggestion` applies the shared rules (one at a time,
 * a cooldown, never during onboarding) and draws the card.
 */

type Props = {
  /** Off on the welcome screen and with no project open. */
  enabled: boolean;
  projectRoot: string | null;
  projectBinding: OpenProjectBinding | null;
  lanes: LaneSummary[];
  githubStatus: GitHubStatus | null;
  navigate: (path: string) => void;
};

const WEEK_MS = 7 * 24 * 3_600_000;
const QUOTA_WINDOWS = new Set(["five_hour", "weekly", "monthly"]);
const TRACKER_LABEL: Record<IssueTracker, string> = { linear: "Linear", jira: "Jira", github: "GitHub" };
const TRACKER_SETTINGS: Record<IssueTracker, string> = {
  linear: "integrations.linear",
  jira: "integrations.jira",
  github: "integrations.github",
};
/** App-wide suggestions file into ADE Tips under one entry, not one per project. */
const APP_SCOPE = "app";

/**
 * The Work view state of the open project. The shell sits above the project's
 * own store, so reads and writes go to the store that owns the project.
 */
function projectWorkView(): { key: string; store: ReturnType<typeof workViewStoreForProject> } | null {
  const key = selectActiveProjectStateKey(useAppStore.getState());
  return key ? { key, store: workViewStoreForProject(key) } : null;
}

export function SituationalSuggestions(props: Props): null {
  const { machines, settled: machinesSettled } = useProjectMachines(props.enabled);
  const otherMachines = machines.filter((machine) => !machine.isThisMachine);
  const onlineMachineName = otherMachines.find((machine) => machine.online)?.machineName ?? null;

  useUsageLowSuggestion(props);
  useMachineMentionSuggestion(props, machinesSettled ? onlineMachineName : null);
  useChatSecretSuggestion(props);
  useIssueTrackerSuggestion(props);
  useParallelChatsSuggestion(props);
  useRepeatPromptSuggestion(props);
  usePairPhoneSuggestion(props, machinesSettled && otherMachines.length === 0);
  // Last: a tip only asks for the slot once these have had their chance.
  useFeatureTipCard(props.enabled);
  return null;
}

/** Plan running low: a Claude or Codex limit at 20% left or less, with only one account signed in. */
function lowQuota(snapshot: UsageSnapshot | null): { key: string; detail: string } | null {
  if (!snapshot) return null;
  let lowest: UsageSnapshot["windows"][number] | null = null;
  for (const quota of snapshot.windows) {
    // Only Claude and Codex can hold a second account here.
    if (!isProviderInstanceProvider(quota.provider)) continue;
    if (quota.unlimited || !QUOTA_WINDOWS.has(quota.windowType)) continue;
    if (!usageLeftLevel(100 - quota.percentUsed)) continue;
    // A provider with a second account already has somewhere to go.
    const accounts = snapshot.accounts?.filter((account) => account.provider === quota.provider).length ?? 0;
    if (accounts > 1) continue;
    if (!lowest || quota.percentUsed > lowest.percentUsed) lowest = quota;
  }
  if (!lowest) return null;
  const left = Math.max(0, Math.round(100 - lowest.percentUsed));
  const resets = formatResetIn(lowest.resetsAt, Date.now());
  const resetHour = Math.round(Date.parse(lowest.resetsAt) / 3_600_000);
  return {
    // Once per provider per reset window.
    key: `${lowest.provider}:${lowest.windowType}:${Number.isFinite(resetHour) ? resetHour : "?"}`,
    detail: `${humanizeProvider(lowest.provider)} has ${left}% of its ${windowLabel(lowest).toLowerCase()} limit left`
      + `${resets ? ` (${resets})` : ""}. `
      + "With another account signed in, new chats can start on the one with room left.",
  };
}

function useUsageLowSuggestion({ enabled, navigate }: Props): void {
  // The tab's machine, like the top bar's meters; Settings opens on the same one.
  const { snapshot } = useUsageSnapshot({ readSnapshot: enabled });
  const low = enabled ? lowQuota(snapshot) : null;
  const start = useCallback(() => navigate(settingsRouteFor("agents.accounts")), [navigate]);
  useSituationalSuggestion({
    id: "usage-low",
    signalKey: low?.key ?? null,
    detail: low?.detail,
    scopeKey: APP_SCOPE,
    start,
  });
}

/** Another machine is connected and the user has never sent work to one with @. */
function useMachineMentionSuggestion({ enabled, lanes, navigate }: Props, machineName: string | null): void {
  const primaryLaneId = lanes.find((lane) => lane.laneType === "primary")?.id ?? null;
  // A new chat in the primary lane on the tab's machine, where the card's "type
  // @" applies. Written to the project's own store: `useLaneChatHandoff` from up
  // here writes the shell's, and an open chat would stay open.
  const start = useMemo(() => {
    if (!primaryLaneId) return null;
    return () => {
      const target = projectWorkView();
      if (!target) return;
      openStartChatDraft(target.store.getState().setWorkViewState, target.key, primaryLaneId, null);
      target.store.getState().selectLane(primaryLaneId);
      navigate("/work");
    };
  }, [navigate, primaryLaneId]);
  const signal = enabled && machineName && !isSuggestionOff("machine-mention") ? "connected" : null;
  useSituationalSuggestion({
    id: "machine-mention",
    signalKey: signal,
    title: machineName ? `Send work to ${machineName} with @` : undefined,
    detail: machineName
      ? `${machineName} is connected. Type @ in any chat and pick it, and the work starts there.`
      : undefined,
    scopeKey: APP_SCOPE,
    context: machineName,
    start,
  });
}

/** A sent message looked like it had a key or password in it. Again only after 30 days. */
function useChatSecretSuggestion({ enabled, navigate }: Props): void {
  const { secretSeq } = useChatSendSignals();
  const start = useCallback(() => navigate(settingsRouteFor("secrets.secrets")), [navigate]);
  useSituationalSuggestion({
    id: "chat-secret",
    signalKey: enabled && secretSeq > 0 ? "sent" : null,
    scopeKey: APP_SCOPE,
    start,
  });
}

/**
 * An issue link was sent for a tracker the tab's machine is not connected to.
 * Each connection is read only when its link shows up (Linear and Jira cache
 * their answer; GitHub's status is the shell's).
 */
function useIssueTrackerSuggestion({ enabled, projectRoot, githubStatus, navigate }: Props): void {
  const { issueTrackers, issueSeq } = useChatSendSignals();
  const [unconnected, setUnconnected] = useState<IssueTracker | null>(null);
  // An unreadable credential store may still hold a working sign-in: not "unconnected".
  const githubConnected = githubStatus
    ? githubStatus.connected || githubStatus.credentialStoreUnreadable === true
    : null;

  useEffect(() => {
    if (!enabled || issueSeq === 0) return undefined;
    let cancelled = false;
    const isConnected = async (tracker: IssueTracker): Promise<boolean> => {
      if (tracker === "github") return githubConnected !== false;
      if (tracker === "jira") return (await loadJiraConnectionStatus(projectRoot))?.connected !== false;
      const status = await window.ade?.cto?.getLinearConnectionStatus?.(null);
      return status?.connected !== false;
    };
    void (async () => {
      for (const tracker of issueTrackers) {
        const connected = await isConnected(tracker).catch(() => true);
        if (cancelled) return;
        if (!connected) {
          setUnconnected(tracker);
          return;
        }
      }
      // This message's links are all connected: the earlier one no longer applies.
      setUnconnected(null);
    })();
    return () => {
      cancelled = true;
    };
    // One read per sent message with a link; `issueSeq` is that message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, issueSeq]);

  const start = useMemo(() => (
    unconnected ? () => navigate(settingsRouteFor(TRACKER_SETTINGS[unconnected])) : null
  ), [navigate, unconnected]);
  const label = unconnected ? TRACKER_LABEL[unconnected] : null;
  useSituationalSuggestion({
    id: "issue-tracker",
    signalKey: enabled ? unconnected : null,
    title: label ? `Connect ${label} to turn issue links into issues` : undefined,
    detail: label
      ? `You sent a ${label} issue link, and ADE is not connected to ${label}. `
        + "Connected, agents can read the issue and lanes can link to it."
      : undefined,
    actionLabel: label ? `Connect ${label}` : undefined,
    scopeKey: unconnected ?? APP_SCOPE,
    context: label,
    start,
  });
  // A tracker filed into Tips earlier can be connected from there too.
  useEffect(() => {
    const offs = (Object.keys(TRACKER_SETTINGS) as IssueTracker[])
      .filter((tracker) => tracker !== unconnected)
      .map((tracker) => registerTrackerStarter(tracker, navigate));
    return () => offs.forEach((off) => off());
  }, [navigate, unconnected]);
}

function registerTrackerStarter(tracker: IssueTracker, navigate: (path: string) => void): () => void {
  return registerSuggestionStarter("issue-tracker", tracker, () => {
    forgetPostponedSuggestion("issue-tracker", tracker);
    navigate(settingsRouteFor(TRACKER_SETTINGS[tracker]));
  });
}

function workingChatCount(itemsById: Readonly<Record<string, AttentionItem>>): number {
  return countActivityBoardColumns(activityFeedItems(itemsById)).working;
}

/** Three or more chats are running at once and the Work grid is not in use. */
function useParallelChatsSuggestion({ enabled, navigate }: Props): void {
  const working = useActivityStore((state) => workingChatCount(state.itemsById));
  const running = enabled && working >= 3;
  const gridOn = useWorkFocusGridOn(running);
  const start = useCallback(() => {
    const target = projectWorkView();
    if (!target) return;
    // The fields `setWorkFocusGrid(true)` writes in `useWorkSessions`.
    target.store.getState().setWorkViewState(target.key, {
      workFocusGrid: true,
      workFoldBusyLanes: true,
      sessionListOrganization: "by-lane",
      workViewMode: "list",
    });
    navigate("/work");
  }, [navigate]);
  useSituationalSuggestion({
    id: "parallel-chats",
    signalKey: running && !gridOn ? "running" : null,
    scopeKey: APP_SCOPE,
    start,
  });
}

/**
 * Whether the open project's Work grid is on, kept current while `watch`:
 * the grid's state lives in the project's own store, so turning it on or off
 * after the chats are running still updates the signal.
 */
function useWorkFocusGridOn(watch: boolean): boolean {
  const projectKey = useAppStore(selectActiveProjectStateKey);
  const store = watch && projectKey ? workViewStoreForProject(projectKey) : null;
  const read = useCallback(
    () => (store && projectKey ? store.getState().workViewByProject[projectKey]?.workFocusGrid === true : false),
    [projectKey, store],
  );
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : () => {}),
    [store],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** The same prompt was sent three times this week in this project. */
function useRepeatPromptSuggestion({ enabled, navigate }: Props): void {
  const { repeatedPrompt } = useChatSendSignals();
  const start = useCallback(() => navigate("/automations"), [navigate]);
  useSituationalSuggestion({
    id: "repeat-prompt",
    signalKey: enabled ? repeatedPrompt : null,
    scopeKey: APP_SCOPE,
    start,
  });
}

/**
 * A week after first run, still only this computer and no phone. The paired
 * devices are read once, when everything else already says "no phone".
 */
function usePairPhoneSuggestion({ enabled }: Props, onlyThisMachine: boolean): void {
  // Read once: first run happened on an earlier launch, so it does not move now.
  const [startedAt] = useState(() => readOnboardingProgress().startedAt);
  const weekOld = startedAt !== undefined && Date.now() - startedAt >= WEEK_MS;
  const candidate = enabled && onlyThisMachine && weekOld && !isSuggestionOff("pair-phone");
  const [noPhone, setNoPhone] = useState(false);
  useEffect(() => {
    if (!candidate || noPhone) return undefined;
    let cancelled = false;
    void Promise.resolve(window.ade?.sync?.listDevices?.())
      .then((devices) => {
        if (cancelled || !devices) return;
        if (devices.some((device) => device.deviceType === "phone")) markSuggestionDone("pair-phone");
        else setNoPhone(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [candidate, noPhone]);
  const start = useCallback(() => openConnectionsPanel("mobile"), []);
  useSituationalSuggestion({
    id: "pair-phone",
    signalKey: candidate && noPhone ? "week-one" : null,
    scopeKey: APP_SCOPE,
    start,
  });
}
