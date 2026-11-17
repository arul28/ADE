import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, Desktop, FolderSimple, GitBranch, WifiSlash } from "@phosphor-icons/react";
import {
  resolveDefaultCopy,
  type RepositoryCopy,
} from "../../../shared/repositoryTab";
import { repositoryTabOfNoMachineTab } from "../../state/repositoryScope";
import { useAppStore, type NoMachineRepositoryTab } from "../../state/appStore";
import { useAccountProjectList, useRepositoryCopies } from "../../state/useRepositoryCopies";
import { adeCloudLaneComputerForMachine, isAdeCloudComputer, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { navigateToAppTarget, openExternalUrl } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { copyMachines, repoKeyForOriginIdentity } from "./projectCopies";
import { startCopyJob, useCopyJobs } from "./projectCopyJobs";
import { requestRemoveProject } from "./removeProjectRequest";
import { ACCOUNT_PROJECT_ID_PATTERN } from "../../../shared/accountProject";
import { PRIMARY_LANE_DISPLAY_NAME } from "../../../shared/laneDisplayName";
import { repoRefForTab } from "../prs/state/prsReader";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { resolveMachinePresence } from "../../../shared/types/power";
import type { AdeAccountMachine } from "../../../shared/types";
import { sameMachineKey } from "../../../shared/machineAddress";
import { fetchAccountMachines } from "../../lib/account";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { isPageHidden, observePageVisibility } from "../../lib/pageVisibility";
import { isWebResumeOwnedTab } from "../app/webResumeOwnedTabs";
import { accountMachinePresence, unconnectedCopyMachineKeys } from "../../state/connectRepositoryCopies";
import { refreshCloudMachines, refreshCloudMachinesIfStale } from "../remoteTargets/useCloudMachines";
import { useSavedChatsOfOrigin } from "../../state/savedChatsOfOrigin";
import {
  accountCloudLaunchesAvailable,
  hideAccountCloudLaunch,
  launchesForOrigin,
  useAccountCloudLaunches,
} from "../../state/accountCloudLaunches";
import type { CloudLaunchRecord } from "../../../shared/accountCloudLaunches";
import { useOwnWebComputers } from "../../state/ownComputers";
import { refreshAccountProjectList } from "../../state/accountProjectListClient";
import {
  AccountProjectSteps,
  CloudChatComposer,
  GithubTabsCard,
  ProjectLanesCard,
  cloudLaneStateWord,
  cloudLanesOfOrigin,
  useGithubAccess,
  type AccountProjectLane,
} from "./AccountProjectSections";
import { CloudSetupCardList, type LaunchChatState } from "./CloudSetupCard";
import { CloneToMachineDialog, type CloneDialogMachine } from "./CloneToMachineDialog";
import "./ProjectWelcomePage.css";

/** One copy's key on this page: its computer and folder. */
function copyKeyOf(copy: RepositoryCopy): string {
  return `${copy.machineId}\n${copy.rootPath}`;
}

/**
 * The copies to connect on their own, in "Start on" order: the computer the
 * tab showed last, then the main and most recently seen copy, ADE Cloud last.
 */
function orderForAutoOpen(copies: readonly RepositoryCopy[], lastCopyKey: string | null): RepositoryCopy[] {
  const wasLast = (copy: RepositoryCopy) => lastCopyKey != null && lastCopyKey.startsWith(`remote:${copy.machineId}:`);
  return [...copies].sort((a, b) => (
    Number(wasLast(b)) - Number(wasLast(a))
    || Number(a.isAdeCloud) - Number(b.isAdeCloud)
    || Number(b.isMain) - Number(a.isMain)
    || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    || a.machineName.localeCompare(b.machineName)
  ));
}

/** How long an automatic connect that answered waits for its copy to open before the next copy is tried. */
const AUTO_OPEN_SETTLE_MS = 20_000;

function openCopy(copy: RepositoryCopy): Promise<unknown> {
  const address = copy.address;
  const store = useAppStore.getState();
  if (!address) return Promise.resolve();
  if (address.kind === "remote") return store.switchRemoteProject(address.targetId, address.projectId);
  return store.switchProjectToPath(address.rootPath, { skipWorktreeGate: true });
}

/**
 * The page of a repository tab with no connected copy (0M, S4). Nobody picks
 * a computer here: when the account lists a computer with a copy as awake,
 * the page connects it and opens its copy by itself, and the tab's other
 * computers join in the background (`useConnectRepositoryCopies`). The page
 * stays only while no computer with a copy is online; then it lists the
 * copies and offers what can bring one back (Connect, Wake, add a copy).
 */
export function ProjectWelcomeNoMachine({ tab }: { tab: NoMachineRepositoryTab }) {
  const webMode = isWebClientMode();
  const navigate = useNavigate();
  // ADE Web connects a computer only when asked, so "not connected" is not
  // "offline" there: a copy whose computer is online opens with one press.
  const workspace = useOptionalWebWorkspace();
  const webMachines = useWebMachines();
  const webMachineByAccountKey = useMemo(
    () => new Map(webMachines.flatMap((machine) => (
      machine.accountMachine?.machineKey ? [[machine.accountMachine.machineKey, machine] as const] : []
    ))),
    [webMachines],
  );
  const [openingCopyKey, setOpeningCopyKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ title: string; technicalDetail: string } | null>(null);
  // A launch's "Open chat" that waits for its computer's copy to be listed.
  const [pendingLaunchOpen, setPendingLaunchOpen] = useState<string | null>(null);
  const list = useAccountProjectList();
  const repositoryTab = useMemo(() => repositoryTabOfNoMachineTab(tab, list), [list, tab]);
  const copies = useRepositoryCopies(repositoryTab);
  const repoAddress = repositoryTab.kind === "account" ? repositoryTab.repoKeys[0]?.slice("repo:".length) ?? null : null;
  const copyRepoKey = repoKeyForOriginIdentity(repoAddress);
  const jobs = useCopyJobs(copyRepoKey);
  const adding = jobs.some((job) => job.status === "cloning" && job.machine.targetId == null);
  const failed = jobs.find((job) => job.status === "failed" && job.machine.targetId == null) ?? null;
  // GitHub reads with the account's own sign-in, with no computer (S14): the
  // project's pull requests, read only. Null for a folder or a non-GitHub host.
  const githubRepo = typeof window !== "undefined" && window.ade?.githubDirect ? repoRefForTab(repositoryTab) : null;
  const githubRepoKey = githubRepo ? `${githubRepo.owner}/${githubRepo.name}` : null;
  // The card names the repository as the account spells it (the read key is lower case).
  const accountProject = list.state === "ready" ? list.projects.find((entry) => entry.id === tab.id) : undefined;
  const githubRepoTitle = accountProject?.owner && accountProject.name ? `${accountProject.owner}/${accountProject.name}` : githubRepoKey;
  // The repository's origin as the account names it; the launches and cloud lanes key on it.
  const origin = repoAddress ? `https://${repoAddress}` : null;
  const githubAccess = useGithubAccess(githubRepo);
  const { entries: launchEntries } = useAccountCloudLaunches();
  const launches = useMemo(
    () => launchesForOrigin(launchEntries, origin).filter((entry) => entry.record?.state !== "cancelled"),
    [launchEntries, origin],
  );
  // A chat on ADE Cloud starts here only where the client talks to the account server for it (ADE Web).
  const cloudChats = accountCloudLaunchesAvailable() && accountProject != null && ACCOUNT_PROJECT_ID_PATTERN.test(tab.id) && origin != null;
  // The cloud lanes come from the account's computers: read them once when no fresh read is in hand.
  // The launch store reads them again when a chat gets its lane.
  useEffect(() => {
    refreshCloudMachinesIfStale();
  }, []);

  // A copy came online: open it. Once per copy, so a copy that fails to open
  // does not loop; the list still offers it.
  const tried = useRef(new Set<string>());
  // A failed open shows as an error banner, which also reports it.
  const [openFailure, setOpenFailure] = useState<{ copy: RepositoryCopy; detail: string } | null>(null);
  // "Open chat" on a computer that had to wake first: the copy opens when it is
  // back (the effect below), then that chat opens, not the new-chat page.
  const chatToOpenRef = useRef<{ record: CloudLaunchRecord; machineKey: string } | null>(null);
  const openRequestRef = useRef(0);
  const openCopyAndReport = useCallback((copy: RepositoryCopy) => {
    setOpenFailure(null);
    const chat = chatToOpenRef.current;
    const opensChat = chat != null && chat.record.sessionId != null && copy.machineKey?.toLowerCase() === chat.machineKey;
    if (opensChat) chatToOpenRef.current = null;
    const request = ++openRequestRef.current;
    void openCopy(copy).then(
      () => {
        // A later open (or another project) won: the earlier chat opens nothing.
        if (request !== openRequestRef.current) return;
        const bound = useAppStore.getState().projectBinding;
        const address = copy.address;
        const sameCopy = bound != null && address != null && (
          bound.kind === "remote" && address.kind === "remote"
            ? bound.targetId === address.targetId
            : bound.kind === "local" && address.kind === "local" && bound.rootPath === address.rootPath
        );
        if (!sameCopy) return;
        if (opensChat && chat.record.sessionId) navigateToAppTarget({ kind: "chat", sessionId: chat.record.sessionId, laneId: chat.record.laneId ?? null });
      },
      (error: unknown) => setOpenFailure({ copy, detail: extractError(error) }),
    );
  }, []);
  // The copy the tab showed before its computer left comes back first.
  const defaultAddress = resolveDefaultCopy({ copies, currentKey: tab.lastCopyKey ?? null });
  useEffect(() => {
    if (!defaultAddress || tried.current.has(defaultAddress.key)) return;
    // ADE Web opens the copy of a tab it moved off a stopped computer again
    // itself; another computer's copy that comes online first opens here.
    if (webMode && isWebResumeOwnedTab(tab.id) && defaultAddress.key === tab.lastCopyKey) return;
    tried.current.add(defaultAddress.key);
    const copy = copies.find((entry) => entry.address?.key === defaultAddress.key);
    if (copy) openCopyAndReport(copy);
  }, [copies, defaultAddress, openCopyAndReport, tab.id, tab.lastCopyKey, webMode]);

  // No copy is connected, but the account lists a computer with one as
  // awake: connect it, and the effect above opens its copy. Nobody picks a
  // computer. One try per computer; a computer the person disconnected or set
  // not to reconnect stays off (`background`), and its row offers Connect.
  const unconnectedKeys = unconnectedCopyMachineKeys(copies);
  // ADE Web holds the account's machines, kept current from the directory.
  // The desktop reads them, and again on focus: a computer started since the
  // page opened is online by then.
  const [desktopAccountMachines, setDesktopAccountMachines] = useState<readonly AdeAccountMachine[] | null>(null);
  // A failed read of the account's computers, with no list from before: the
  // page cannot tell an awake computer from an off one, so it says that
  // instead of calling every copy offline. "Try again" reads past the cache.
  const [desktopDirectoryFailure, setDesktopDirectoryFailure] = useState<string | null>(null);
  const [directoryRetries, setDirectoryRetries] = useState(0);
  useEffect(() => {
    if (webMode || !unconnectedKeys) return;
    let cancelled = false;
    const read = (force: boolean) => {
      void fetchAccountMachines({ force }).then((result) => {
        if (cancelled) return;
        if (result.state === "ok") {
          setDesktopAccountMachines(result.machines);
          setDesktopDirectoryFailure(null);
        } else if (result.state === "unavailable") {
          setDesktopDirectoryFailure(result.message ?? "The account directory did not answer.");
        }
      });
    };
    const onFocus = () => read(false);
    read(directoryRetries > 0);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [directoryRetries, unconnectedKeys, webMode]);
  const accountMachines = webMode ? workspace?.account.machines ?? null : desktopAccountMachines;
  const directoryFailure = webMode
    ? workspace?.account.state === "directory_unavailable" && (workspace.account.machines.length === 0)
      ? workspace.account.message ?? "The account directory did not answer."
      : null
    : desktopAccountMachines == null ? desktopDirectoryFailure : null;
  const accountMachineOf = useCallback((copy: RepositoryCopy): AdeAccountMachine | undefined => (
    copy.machineKey ? accountMachines?.find((machine) => sameMachineKey(machine.machineKey, copy.machineKey)) : undefined
  ), [accountMachines]);
  // Any ADE Cloud computer, with a lane or not: it sleeps, and Wake starts it.
  const cloudIndex = useAdeCloudLaneComputers();
  /**
   * A copy's computer, as the person should see it: ADE Cloud's own word that
   * it sleeps wins, since the account keeps an ADE Cloud computer "online" for
   * minutes after it went to sleep.
   */
  const copyPresence = useCallback((copy: RepositoryCopy) => {
    const computer = copy.machineKey ? adeCloudLaneComputerForMachine({ machineKey: copy.machineKey }, cloudIndex.computers) : null;
    if (computer?.state === "asleep" || computer?.state === "stopped") return "asleep" as const;
    return accountMachinePresence(accountMachineOf(copy));
  }, [accountMachineOf, cloudIndex.computers]);
  const autoTried = useRef(new Set<string>());
  // A hidden page connects nothing on its own; the try waits until it is shown.
  const [pageShown, setPageShown] = useState(() => !isPageHidden());
  useEffect(() => observePageVisibility({
    onHidden: () => setPageShown(false),
    onVisible: () => setPageShown(true),
  }), []);
  const [autoOpen, setAutoOpen] = useState<{ machineKey: string; machineName: string } | null>(null);
  const [connectFailure, setConnectFailure] = useState<{ machineName: string; detail: string } | null>(null);
  useEffect(() => {
    if (defaultAddress || autoOpen || !accountMachines || !pageShown) return;
    const connect = window.ade?.machines?.connect;
    if (!isAdeAvailable(connect)) return;
    // ADE Web opens the copy of a tab it moved off a stopped computer again
    // itself (see the effect above); this page connects only the others.
    const resumeOwned = webMode && isWebResumeOwnedTab(tab.id);
    const next = orderForAutoOpen(
      copies.filter((copy) => (
        !copy.isThisMachine
        && !copy.online
        && copy.machineKey != null
        && !autoTried.current.has(copy.machineKey.toLowerCase())
        && !(resumeOwned && tab.lastCopyKey?.startsWith(`remote:${copy.machineId}:`))
        && copyPresence(copy) === "online"
      )),
      tab.lastCopyKey ?? null,
    )[0];
    const machineKey = next?.machineKey;
    if (!next || !machineKey) return;
    autoTried.current.add(machineKey.toLowerCase());
    setConnectFailure(null);
    setAutoOpen({ machineKey, machineName: next.machineName });
    const settle = () => setAutoOpen((current) => (current?.machineKey === machineKey ? null : current));
    void connect(machineKey, { background: true }).then(
      (result) => {
        if (result.ok) {
          // The copy opens when the connection lists it; until then the page
          // says which computer it is opening on.
          window.setTimeout(settle, AUTO_OPEN_SETTLE_MS);
          return;
        }
        if (result.reason !== "declined") setConnectFailure({ machineName: next.machineName, detail: result.message });
        settle();
      },
      (error: unknown) => {
        setConnectFailure({ machineName: next.machineName, detail: extractError(error) });
        settle();
      },
    );
  }, [accountMachines, autoOpen, copies, copyPresence, defaultAddress, pageShown, tab.id, tab.lastCopyKey, webMode]);

  // A row's Connect or Wake: the person asked, so this connect wakes a
  // sleeping ADE Cloud computer and clears a Disconnect.
  const [manualConnectKey, setManualConnectKey] = useState<string | null>(null);
  const connectCopy = (copy: RepositoryCopy) => {
    const connect = window.ade?.machines?.connect;
    const machineKey = copy.machineKey;
    if (!isAdeAvailable(connect) || !machineKey) return;
    setConnectFailure(null);
    setManualConnectKey(machineKey);
    void connect(machineKey).then(
      (result) => {
        if (!result.ok) setConnectFailure({ machineName: copy.machineName, detail: result.message });
      },
      (error: unknown) => setConnectFailure({ machineName: copy.machineName, detail: extractError(error) }),
    ).finally(() => setManualConnectKey((current) => (current === machineKey ? null : current)));
  };

  const addLocalCopy = () => {
    const local = copyMachines(null, { includeLocal: true })[0];
    if (!copyRepoKey || !local) return;
    const name = copyRepoKey.split("/").pop() ?? tab.displayName;
    startCopyJob(
      {
        repoKey: copyRepoKey,
        url: `https://${copyRepoKey}`,
        name,
        parentDir: null,
        displayName: name,
        machine: { machineId: local.machineId, name: local.name, targetId: local.targetId },
      },
      (result) => {
        if (result.kind === "local") void useAppStore.getState().switchProjectToPath(result.rootPath, { skipWorktreeGate: true });
      },
    );
  };

  /** The web machine row of a copy's computer, if the account lists it. */
  const webMachineOf = (copy: RepositoryCopy): WebMachineEntry | null => (
    workspace && copy.machineKey ? webMachineByAccountKey.get(copy.machineKey) ?? null : null
  );
  /**
   * The web machine that can open this copy on a press: held by this tab, or
   * awake in the account directory ("available" alone also covers asleep and
   * long-gone computers), and the copy names its folder. A machine that is
   * dialing again (it stopped) is not one to pick, unless this page is
   * opening that copy now.
   */
  const webMachineFor = (copy: RepositoryCopy): WebMachineEntry | null => {
    const machine = copy.checkoutId ? webMachineOf(copy) : null;
    if (!machine) return null;
    const opening = openingCopyKey === copyKeyOf(copy);
    const held = machine.status === "live" || machine.status === "parked" || (machine.status === "connecting" && opening);
    const awake = machine.accountMachine != null && copyPresence(copy) === "online";
    return held || (machine.status === "available" && awake) ? machine : null;
  };
  const openOnWeb = (copy: RepositoryCopy, machine: WebMachineEntry, chat?: CloudLaunchRecord) => {
    const checkoutId = copy.checkoutId;
    if (!workspace || !checkoutId) return;
    const copyKey = copyKeyOf(copy);
    setOpenError(null);
    setOpeningCopyKey(copyKey);
    void (async () => {
      try {
        const targetId = await workspace.connectMachineEntry(machine);
        await workspace.adapter.openProject(targetId, checkoutId);
        // The project is open now; leave this page as the desktop does when a copy opens.
        useAppStore.setState((state) => (state.activeNoMachineTabId === tab.id ? { activeNoMachineTabId: null } : {}));
        const pendingPath = workspace.consumePendingProjectPath();
        // "Open chat" lands on that chat, not on the project's new-chat page.
        if (chat?.sessionId) navigateToAppTarget({ kind: "chat", sessionId: chat.sessionId, laneId: chat.laneId ?? null });
        else navigate(pendingPath ?? "/work");
      } catch (error) {
        setOpenError({
          title: `${machine.name} did not open ${tab.displayName}.`,
          technicalDetail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setOpeningCopyKey((current) => (current === copyKey ? null : current));
      }
    })();
  };
  const webOpenable = webMode && copies.some((copy) => webMachineFor(copy) != null);
  // ADE Web: the person's own computers that are on and have no copy yet. Clone here opens the clone dialog.
  const ownComputers = useOwnWebComputers();
  const copyMachineKeys = new Set(copies.flatMap((copy) => (copy.machineKey ? [copy.machineKey.toLowerCase()] : [])));
  const machinesWithoutCopy = webMode
    ? ownComputers.filter((machine) => {
      const account = machine.accountMachine;
      const key = account?.machineKey?.toLowerCase();
      if (!account || !key || copyMachineKeys.has(key) || machine.rememberedOnly) return false;
      const awake = resolveMachinePresence({
        connected: false,
        online: account.online,
        sleepState: account.sleepState,
        sleepStateAt: account.sleepStateAt,
        lastSeenAt: account.lastSeenAt,
      }) === "online";
      return machine.status === "live" || machine.status === "parked" || (machine.status === "available" && awake);
    })
    : [];
  /** The machine the clone dialog clones to, with the folders of its other projects. */
  const [cloneTarget, setCloneTarget] = useState<(CloneDialogMachine & { otherProjectPaths: string[] }) | null>(null);
  const [cloneConnecting, setCloneConnecting] = useState<string | null>(null);
  const cloneOn = (machine: WebMachineEntry) => {
    if (!workspace) return;
    setOpenError(null);
    setCloneConnecting(machine.key);
    void workspace.connectMachineEntry(machine).then(
      (targetId) => setCloneTarget({
        machineId: targetId,
        name: machine.name,
        targetId,
        otherProjectPaths: machine.projects.map((project) => project.rootPath).filter((path): path is string => typeof path === "string"),
      }),
      (error: unknown) => setOpenError({ title: `Couldn't connect to ${machine.name}`, technicalDetail: extractError(error) }),
    ).finally(() => setCloneConnecting(null));
  };
  const openClone = (target: { kind: "local"; rootPath: string } | { kind: "remote"; targetId: string; projectId: string }, machineName: string) => {
    setCloneTarget(null);
    if (target.kind === "local") {
      void useAppStore.getState().switchProjectToPath(target.rootPath, { skipWorktreeGate: true });
      return;
    }
    if (!workspace) return;
    void (async () => {
      try {
        await workspace.adapter.openProject(target.targetId, target.projectId);
        useAppStore.setState((state) => (state.activeNoMachineTabId === tab.id ? { activeNoMachineTabId: null } : {}));
        navigate(workspace.consumePendingProjectPath() ?? "/work");
      } catch (error) {
        setOpenError({ title: `${machineName} did not open ${tab.displayName}.`, technicalDetail: extractError(error) });
      }
    })();
  };
  const onAdeCloud = (copy: RepositoryCopy): boolean => (
    copy.isAdeCloud || isAdeCloudComputer({ machineKey: copy.machineKey }, cloudIndex)
  );
  /** "Connect" for a copy on an awake computer with no connection here, "Wake" for a resting ADE Cloud computer. */
  const wakeOrConnectLabel = (copy: RepositoryCopy): "Connect" | "Wake" | null => {
    if (copy.isThisMachine || copy.online || !copy.machineKey) return null;
    const presence = copyPresence(copy);
    if (presence === "online") return "Connect";
    return onAdeCloud(copy) && presence === "asleep" ? "Wake" : null;
  };
  /**
   * The state word of a copy's computer, the same on ADE Web and the desktop:
   * "Asleep" only for an ADE Cloud computer that went to sleep (it can sleep
   * for days with no heartbeat), "Offline" for every other computer.
   */
  const offlineWord = (copy: RepositoryCopy): string => {
    // ADE Web still dialing a computer says so until the try ends.
    const webMachine = webMode ? webMachineOf(copy) : null;
    if (webMachine?.status === "connecting") return webMachine.statusLabel;
    if (!onAdeCloud(copy)) return "Offline";
    return copyPresence(copy) === "asleep" || accountMachineOf(copy)?.sleepState === "asleep" ? "Asleep" : "Offline";
  };
  const connectable = webOpenable || copies.some((copy) => wakeOrConnectLabel(copy) != null);
  // Every computer the page can reach is an asleep ADE Cloud computer: the
  // action is Wake, not Connect.
  const wakeOnly = connectable && !webOpenable && copies.every((copy) => wakeOrConnectLabel(copy) !== "Connect");
  // The computer this page is opening the project on now, if any.
  const opening = autoOpen?.machineName
    ?? (openingCopyKey ? copies.find((copy) => copyKeyOf(copy) === openingCopyKey)?.machineName : undefined)
    ?? (manualConnectKey ? copies.find((copy) => copy.machineKey === manualConnectKey)?.machineName : undefined)
    ?? null;

  const canAddLocal = !webMode && copyRepoKey != null && !copies.some((copy) => copy.isThisMachine);
  /** The copy on a cloud lane's computer, once that computer registered it. */
  const copyOnComputer = (instanceId: string | null, machineKey: string | null): RepositoryCopy | null => (
    copies.find((copy) => (
      (machineKey != null && copy.machineKey != null && sameMachineKey(copy.machineKey, machineKey))
      || (instanceId != null && isAdeCloudComputer({ machineKey: copy.machineKey }, cloudIndex)
        && cloudIndex.computers.some((computer) => computer.instanceId === instanceId && computer.machineKey === copy.machineKey))
    )) ?? null
  );
  const openCloudCopy = (copy: RepositoryCopy, chat?: CloudLaunchRecord) => {
    const webMachine = webMode ? webMachineFor(copy) : null;
    if (webMachine) openOnWeb(copy, webMachine, chat);
    else if (copy.online && copy.address) openCopyAndReport(copy);
    else connectCopy(copy);
  };
  const launchCopy = (instanceId: string | null): RepositoryCopy | null => {
    const computer = cloudIndex.computers.find((entry) => entry.instanceId === instanceId) ?? null;
    return copyOnComputer(instanceId, computer?.machineKey ?? null);
  };
  const openLaunchChat = (record: CloudLaunchRecord) => {
    const machineKey = cloudIndex.computers.find((entry) => entry.instanceId === record.instanceId)?.machineKey?.toLowerCase() ?? null;
    chatToOpenRef.current = machineKey ? { record, machineKey } : null;
    const copy = launchCopy(record.instanceId);
    if (copy) {
      openCloudCopy(copy, record);
      return;
    }
    // The computer or its copy isn't listed here yet: read both again, and open it once it is.
    setPendingLaunchOpen(record.instanceId);
    refreshCloudMachines();
    void refreshAccountProjectList({ force: true });
  };
  const pendingCopy = pendingLaunchOpen ? launchCopy(pendingLaunchOpen) : null;
  useEffect(() => {
    if (!pendingCopy) return;
    const record = launches.find((entry) => entry.record?.instanceId === pendingLaunchOpen)?.record ?? undefined;
    setPendingLaunchOpen(null);
    openCloudCopy(pendingCopy, record);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the copy appears
  }, [pendingCopy?.machineKey, pendingCopy?.checkoutId]);
  // A copy that never appears: read again every few seconds for a minute, then stop.
  useEffect(() => {
    if (!pendingLaunchOpen) return;
    let reads = 0;
    const timer = window.setInterval(() => {
      reads += 1;
      if (reads > 12) {
        window.clearInterval(timer);
        setPendingLaunchOpen(null);
        setOpenError({ title: "Couldn't open the chat yet. Try again in a moment.", technicalDetail: `ADE Cloud computer ${pendingLaunchOpen} has no project copy listed` });
        return;
      }
      refreshCloudMachines();
      void refreshAccountProjectList({ force: true });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [pendingLaunchOpen]);
  const cloudLanes = cloudLanesOfOrigin(cloudIndex.computers, launches, origin);
  // A lane whose chat is still starting (making its computer, waiting for a sign-in) is not one yet.
  const readyCloudLaneIds = cloudLanes.filter((lane) => !lane.launch || Boolean(lane.launch.record?.sessionId)).map((lane) => lane.laneId);
  // The account's saved chats of this repository count too: a chat whose computer slept or was deleted still happened.
  const savedChats = useSavedChatsOfOrigin(origin);
  const accountLaneCount = new Set([...readyCloudLaneIds, ...savedChats.flatMap((chat) => (chat.laneId ? [chat.laneId] : []))]).size;
  const accountChatCount = Math.max(readyCloudLaneIds.length, savedChats.length);
  const laneRows: AccountProjectLane[] = cloudLanes.map((lane) => {
    const copy = copyOnComputer(lane.computer?.instanceId ?? lane.launch?.record?.instanceId ?? null, lane.computer?.machineKey ?? null);
    return {
      key: `cloud:${lane.laneId}`,
      name: lane.laneName,
      where: "ADE Cloud",
      state: cloudLaneStateWord(lane),
      onOpen: copy ? () => openCloudCopy(copy) : null,
    };
  });
  // The account's copy of a chat is saved when a turn ends, so it can be stale
  // while the chat runs again elsewhere. Only a chat whose computer is deleted
  // is surely done; otherwise the card names the lane without a state.
  const savedChatStateOf = (record: CloudLaunchRecord): LaunchChatState | null => {
    const saved = savedChats.find((chat) => (record.sessionId && chat.chatId === record.sessionId) || (record.laneId != null && chat.laneId === record.laneId));
    return saved?.computer?.state === "deleted" ? "done" : null;
  };
  // Lanes whose chats were saved on the account, with their computer asleep or deleted, are lanes still.
  const listedLaneIds = new Set(cloudLanes.map((lane) => lane.laneId));
  for (const chat of savedChats) {
    if (!chat.laneId || listedLaneIds.has(chat.laneId)) continue;
    listedLaneIds.add(chat.laneId);
    laneRows.push({
      key: `saved:${chat.laneId}`,
      name: chat.laneName?.trim() || chat.title?.trim() || "Chat",
      where: "ADE Cloud",
      state: chat.computer?.state === "deleted" ? "Computer deleted" : "Saved",
      onOpen: null,
    });
  }
  // Copies on the person's own computers are lanes too: each copy's main checkout.
  for (const copy of copies) {
    if (onAdeCloud(copy)) continue;
    laneRows.push({
      key: `copy:${copyKeyOf(copy)}`,
      name: PRIMARY_LANE_DISPLAY_NAME,
      where: copy.machineName,
      state: copy.online ? "Online" : offlineWord(copy),
      onOpen: null,
    });
  }
  // Copies on the person's own computers, or a way to add one: the copies card shows only then.
  const ownCopies = copies.filter((copy) => !onAdeCloud(copy));
  const showCopiesCard = ownCopies.length > 0 || canAddLocal || machinesWithoutCopy.length > 0 || opening != null
    || openError != null || connectFailure != null || openFailure != null || (failed != null && !adding);
  // Leaving the account needs the account project id and this computer's account call (desktop).
  const canLeaveAccount = !webMode
    && ACCOUNT_PROJECT_ID_PATTERN.test(tab.id)
    && typeof window.ade?.project?.accountRemove === "function";

  const headerTitle = accountProject?.name ?? tab.displayName;
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-6">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={tab.displayName}>
          {tab.iconDataUrl ? (
            <img src={tab.iconDataUrl} alt="" className="h-4 w-4 rounded-sm" />
          ) : (
            <FolderSimple size={16} aria-hidden style={{ color: "var(--kit-text-3)" }} />
          )}
          <h1 className="m-0 min-w-0 truncate text-[17px] font-semibold" style={{ letterSpacing: "-0.01em" }}>{headerTitle}</h1>
          {githubRepoTitle && githubRepoTitle !== headerTitle ? (
            <span className="truncate text-[12px]" style={{ color: "var(--kit-text-3)" }}>{githubRepoTitle}</span>
          ) : null}
          {accountProject?.defaultBranch ? (
            <span className="kit-tag flex items-center gap-1"><GitBranch size={11} aria-hidden />{accountProject.defaultBranch}</span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            {githubRepo ? (
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                data-size="sm"
                onClick={() => openExternalUrl(`https://github.com/${githubRepo.owner}/${githubRepo.name}`)}
              >
                GitHub <ArrowSquareOut size={11} aria-hidden />
              </button>
            ) : null}
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => useAppStore.getState().closeNoMachineTab(tab.id)}>
              Close tab
            </button>
            {canLeaveAccount ? (
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                data-size="sm"
                data-tone="crit"
                onClick={() => requestRemoveProject({ kind: "no-machine", id: tab.id, displayName: tab.displayName })}
              >
                Remove from account…
              </button>
            ) : null}
          </span>
        </header>
        {githubRepo && accountProject ? (
          <AccountProjectSteps owner={githubRepo.owner} access={githubAccess} launches={launches} chatCount={accountChatCount} laneCount={accountLaneCount + ownCopies.length} />
        ) : null}
        {cloudChats && origin ? (
          <CloudChatComposer accountProjectId={tab.id} origin={origin} owner={githubRepo?.owner ?? accountProject?.owner ?? null} access={githubAccess} />
        ) : null}
        <CloudSetupCardList
          entries={launches}
          onOpenChat={openLaunchChat}
          onHide={hideAccountCloudLaunch}
          openingLaunchId={pendingLaunchOpen == null ? null : launches.find((entry) => entry.record?.instanceId === pendingLaunchOpen)?.launchId ?? null}
          chatStateOf={savedChatStateOf}
        />
        {showCopiesCard ? (
      <section className="kit-card w-full" aria-label="Computers">
        <header className="kit-card-head">
          <Desktop size={13} aria-hidden />
          <span className="min-w-0 truncate">Computers</span>
        </header>
        <div className="kit-card-body flex flex-col gap-3">
          {copies.length > 0 || opening ? (
          <div className="flex items-start gap-2">
            {opening || connectable ? (
              <Desktop size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--kit-text-3)" }} />
            ) : (
              <WifiSlash size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--kit-text-3)" }} />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-[13px] font-semibold">
                {opening
                  ? `Opening on ${opening}…`
                  : wakeOnly
                    ? "A computer with this project is asleep"
                    : connectable
                    ? "A computer with this project is not connected"
                    : directoryFailure && copies.length > 0
                      ? "ADE couldn't check which computers are on"
                      : "No computer with this project is online"}
              </strong>
              <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>
                {opening
                  ? "The project opens here when it answers."
                  : wakeOnly
                    ? "Wake it to open the project here."
                    : connectable
                    ? "Connect it to open the project here."
                    : webMode
                        ? "Turn on one of these computers to open it here."
                        : "The project opens here as soon as one is."}
              </span>
            </div>
          </div>
          ) : (
            <p className="m-0 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
              {canAddLocal ? "Copy it here to work on it from this computer too." : "Clone it on one of your computers to work on it there too."}
            </p>
          )}
          {copies.length > 0 || machinesWithoutCopy.length > 0 ? (
            <div className="kit-panel flex flex-col py-1" role="list" aria-label="Copies">
              {copies.map((copy) => {
                const copyKey = copyKeyOf(copy);
                const webMachine = webMode ? webMachineFor(copy) : null;
                const wakeOrConnect = webMachine ? null : wakeOrConnectLabel(copy);
                return (
                <div key={copyKey} role="listitem" className="kit-row flex items-center gap-2 px-2.5 py-1.5">
                  <Desktop size={13} aria-hidden className="shrink-0" style={{ color: "var(--kit-text-3)" }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px]">{copy.machineName}</span>
                    <span className="truncate text-[11px]" style={{ color: "var(--kit-text-3)" }} title={copy.rootPath}>
                      {copy.rootPath}
                    </span>
                  </span>
                  {webMachine ? (
                    <button
                      type="button"
                      className="kit-btn"
                      data-size="sm"
                      disabled={openingCopyKey != null || autoOpen != null}
                      onClick={() => openOnWeb(copy, webMachine)}
                    >
                      {openingCopyKey === copyKey ? "Opening…" : "Connect"}
                    </button>
                  ) : !webMode && copy.online && copy.address ? (
                    <button type="button" className="kit-btn" data-size="sm" onClick={() => openCopyAndReport(copy)}>
                      Open
                    </button>
                  ) : wakeOrConnect ? (
                    <>
                    {wakeOrConnect === "Wake" ? <span className="kit-tag shrink-0">Asleep</span> : null}
                    <button
                      type="button"
                      className="kit-btn"
                      data-size="sm"
                      disabled={manualConnectKey != null || autoOpen != null}
                      onClick={() => connectCopy(copy)}
                    >
                      {manualConnectKey != null && manualConnectKey === copy.machineKey ? "Connecting…" : wakeOrConnect}
                    </button>
                    </>
                  ) : (
                    <span className="kit-tag shrink-0">{offlineWord(copy)}</span>
                  )}
                </div>
                );
              })}
              {machinesWithoutCopy.map((machine) => (
                <div key={`no-copy:${machine.key}`} role="listitem" className="kit-row flex items-center gap-2 px-2.5 py-1.5">
                  <Desktop size={13} aria-hidden className="shrink-0" style={{ color: "var(--kit-text-3)" }} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{machine.name}</span>
                  <span className="kit-tag shrink-0">No copy yet</span>
                  <button type="button" className="kit-btn" data-size="sm" disabled={cloneConnecting != null} onClick={() => cloneOn(machine)}>
                    {cloneConnecting === machine.key ? "Connecting…" : "Clone here"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {openError ? (
            <Banner
              layout="inline"
              model={{
                id: "no-machine-open",
                tone: "error",
                title: openError.title,
                detail: "Try again, or open the project on another computer.",
                report: { surface: "no_machine_open", technicalDetail: openError.technicalDetail },
              }}
            />
          ) : null}
          {directoryFailure && !opening && !connectable && copies.length > 0 ? (
            <Banner
              layout="inline"
              model={{
                id: "no-machine-directory",
                tone: "error",
                title: "Couldn't read your account's computers",
                detail: directoryFailure,
                ...(webMode ? {} : { actions: [{ label: "Try again", onClick: () => setDirectoryRetries((count) => count + 1) }] }),
                report: { surface: "repository_tab_no_machine", code: "account_machines_unavailable", technicalDetail: directoryFailure },
              }}
            />
          ) : null}
          {connectFailure && !opening ? (
            <Banner
              layout="inline"
              model={{
                id: "no-machine-connect",
                tone: "error",
                title: `Couldn't connect to ${connectFailure.machineName}`,
                detail: "Try again, or turn on another computer with this project.",
                report: { surface: "repository_tab_no_machine", code: "connect_copy_failed", technicalDetail: connectFailure.detail },
              }}
            />
          ) : null}
          {openFailure ? (
            <Banner
              layout="inline"
              model={{
                id: "no-machine-open-copy",
                tone: "error",
                title: `Couldn't open the copy on ${openFailure.copy.machineName}`,
                actions: [{ label: "Try again", onClick: () => openCopyAndReport(openFailure.copy) }],
                report: { surface: "repository_tab_no_machine", code: "open_copy_failed", technicalDetail: openFailure.detail },
              }}
            />
          ) : null}
          {/* The add button below is the retry. */}
          {failed && !adding ? (
            <Banner
              layout="inline"
              model={{
                id: "no-machine-add-copy",
                tone: "error",
                title: "Couldn't copy it here",
                detail: failed.failure?.reason ?? undefined,
                report: { surface: "repository_tab_no_machine", code: "add_local_copy_failed" },
              }}
            />
          ) : null}
          {canAddLocal || !webMode ? (
          <div className="flex flex-wrap items-center gap-2">
            {canAddLocal ? (
              <button type="button" className="kit-btn kit-btn-primary" disabled={adding} onClick={addLocalCopy}>
                {adding ? "Copying…" : "Copy here"}
              </button>
            ) : null}
            {/* ADE Web has no connections panel; its rows above connect a computer. */}
            {webMode ? null : (
              <button type="button" className="kit-btn" onClick={() => openConnectionsPanel("machines")}>
                Connect a computer
              </button>
            )}
          </div>
          ) : null}
        </div>
      </section>
        ) : null}
        <ProjectLanesCard lanes={laneRows} />
        {githubRepo ? <GithubTabsCard repo={githubRepo} defaultBranch={accountProject?.defaultBranch ?? null} /> : null}
      </div>
      {cloneTarget && copyRepoKey ? (
        <CloneToMachineDialog
          open
          machine={cloneTarget}
          repoKey={copyRepoKey}
          url={`https://${copyRepoKey}`}
          repoName={copyRepoKey.split("/").pop() ?? tab.displayName}
          otherProjectPaths={cloneTarget.otherProjectPaths}
          confirmLabel="Clone & open"
          sendsMessage={false}
          onCancel={() => setCloneTarget(null)}
          onReady={(target) => openClone(target, cloneTarget.name)}
        />
      ) : null}
    </div>
  );
}
