import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Desktop, FolderSimple, WifiSlash } from "@phosphor-icons/react";
import {
  repositoryTabFromAccountProject,
  resolveDefaultCopy,
  type RepositoryCopy,
  type RepositoryTab,
} from "../../../shared/repositoryTab";
import { useAppStore, type NoMachineRepositoryTab } from "../../state/appStore";
import { useAccountProjectList, useRepositoryCopies } from "../../state/useRepositoryCopies";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { isWebClientMode } from "../../lib/webClientMode";
import { copyMachines, repoKeyForOriginIdentity } from "./projectCopies";
import { startCopyJob, useCopyJobs } from "./projectCopyJobs";
import { requestRemoveProject } from "./removeProjectRequest";
import { ACCOUNT_PROJECT_ID_PATTERN } from "../../../shared/accountProject";
import { repoRefForTab } from "../prs/state/prsReader";
import { PullRequestsCard } from "./ProjectWelcomeHome";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import { useDirectHomePullRequests } from "./useDirectHomePullRequests";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { resolveMachinePresence } from "../../../shared/types/power";
import type { AdeAccountMachine } from "../../../shared/types";
import { sameMachineKey } from "../../../shared/machineAddress";
import { fetchAccountMachines } from "../../lib/account";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { isWebResumeOwnedTab } from "../app/webResumeOwnedTabs";
import { unconnectedCopyMachineKeys } from "../../state/connectRepositoryCopies";
import "./ProjectWelcomePage.css";

/** The repository tab of a no-machine tab: the account project when the account knows it. */
function repositoryTabOf(tab: NoMachineRepositoryTab, list: ReturnType<typeof useAccountProjectList>): RepositoryTab {
  // A second folder of a repository on one computer keys its tab by that
  // folder; the repository is named apart.
  const repositoryId = tab.repositoryId ?? tab.id;
  const project = list.state === "ready" ? list.projects.find((entry) => entry.id === repositoryId) : undefined;
  if (project) return repositoryTabFromAccountProject(project, { displayName: tab.displayName, iconDataUrl: tab.iconDataUrl });
  const address = repositoryId.startsWith("repo:") ? repositoryId.slice("repo:".length) : repositoryId;
  return {
    kind: "account",
    id: repositoryId,
    displayName: tab.displayName,
    iconDataUrl: tab.iconDataUrl,
    host: address.split("/")[0]?.toLowerCase() || "github.com",
    repoKeys: [repositoryId.startsWith("repo:") ? repositoryId : `repo:${address}`],
  };
}

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

function accountPresence(machine: AdeAccountMachine | undefined): ReturnType<typeof resolveMachinePresence> | null {
  if (!machine) return null;
  return resolveMachinePresence({
    connected: false,
    online: machine.online,
    sleepState: machine.sleepState,
    sleepStateAt: machine.sleepStateAt,
    lastSeenAt: machine.lastSeenAt,
  });
}

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
  const list = useAccountProjectList();
  const repositoryTab = useMemo(() => repositoryTabOf(tab, list), [list, tab]);
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
  const pullRequests = useDirectHomePullRequests(githubRepo);

  // A copy came online: open it. Once per copy, so a copy that fails to open
  // does not loop; the list still offers it.
  const tried = useRef(new Set<string>());
  // A failed open shows as an error banner, which also reports it.
  const [openFailure, setOpenFailure] = useState<{ copy: RepositoryCopy; detail: string } | null>(null);
  const openCopyAndReport = useCallback((copy: RepositoryCopy) => {
    setOpenFailure(null);
    void openCopy(copy).catch((error: unknown) => setOpenFailure({ copy, detail: extractError(error) }));
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
  useEffect(() => {
    if (webMode || !unconnectedKeys) return;
    let cancelled = false;
    const read = () => {
      void fetchAccountMachines().then((result) => {
        if (!cancelled && result.state === "ok") setDesktopAccountMachines(result.machines);
      });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [unconnectedKeys, webMode]);
  const accountMachines = webMode ? workspace?.account.machines ?? null : desktopAccountMachines;
  const accountMachineOf = useCallback((copy: RepositoryCopy): AdeAccountMachine | undefined => (
    copy.machineKey ? accountMachines?.find((machine) => sameMachineKey(machine.machineKey, copy.machineKey)) : undefined
  ), [accountMachines]);
  const autoTried = useRef(new Set<string>());
  const [autoOpen, setAutoOpen] = useState<{ machineKey: string; machineName: string } | null>(null);
  const [connectFailure, setConnectFailure] = useState<{ machineName: string; detail: string } | null>(null);
  useEffect(() => {
    if (defaultAddress || autoOpen || !accountMachines) return;
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
        && accountPresence(accountMachineOf(copy)) === "online"
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
  }, [accountMachineOf, accountMachines, autoOpen, copies, defaultAddress, tab.id, tab.lastCopyKey, webMode]);

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
    const account = machine.accountMachine;
    const awake = account != null && resolveMachinePresence({
      connected: false,
      online: account.online,
      sleepState: account.sleepState,
      sleepStateAt: account.sleepStateAt,
      lastSeenAt: account.lastSeenAt,
    }) === "online";
    return held || (machine.status === "available" && awake) ? machine : null;
  };
  const openOnWeb = (copy: RepositoryCopy, machine: WebMachineEntry) => {
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
        navigate(workspace.consumePendingProjectPath() ?? "/work");
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
  /** "Connect" for a copy on an awake computer with no connection here, "Wake" for a resting ADE Cloud computer. */
  const wakeOrConnectLabel = (copy: RepositoryCopy): "Connect" | "Wake" | null => {
    if (copy.isThisMachine || copy.online || !copy.machineKey) return null;
    const presence = accountPresence(accountMachineOf(copy));
    if (presence === "online") return "Connect";
    return copy.isAdeCloud && presence === "asleep" ? "Wake" : null;
  };
  const connectable = webOpenable || copies.some((copy) => wakeOrConnectLabel(copy) != null);
  // The computer this page is opening the project on now, if any.
  const opening = autoOpen?.machineName
    ?? (openingCopyKey ? copies.find((copy) => copyKeyOf(copy) === openingCopyKey)?.machineName : undefined)
    ?? (manualConnectKey ? copies.find((copy) => copy.machineKey === manualConnectKey)?.machineName : undefined)
    ?? null;

  const canAddLocal = !webMode && copyRepoKey != null && !copies.some((copy) => copy.isThisMachine);
  // Leaving the account needs the account project id and this computer's account call (desktop).
  const canLeaveAccount = !webMode
    && ACCOUNT_PROJECT_ID_PATTERN.test(tab.id)
    && typeof window.ade?.project?.accountRemove === "function";

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 overflow-y-auto p-6">
      <section className="kit-card w-full max-w-[460px]" aria-label={`${tab.displayName}: no computer online`}>
        <header className="kit-card-head">
          {tab.iconDataUrl ? (
            <img src={tab.iconDataUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />
          ) : (
            <FolderSimple size={14} aria-hidden />
          )}
          <span className="min-w-0 truncate">{tab.displayName}</span>
        </header>
        <div className="kit-card-body flex flex-col gap-3">
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
                  : connectable
                    ? "A computer with this project is not connected"
                    : copies.length > 0 ? "No computer with this project is online" : "No computer has a copy yet"}
              </strong>
              <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>
                {opening
                  ? "The project opens here when it answers."
                  : connectable
                    ? "Connect it to open the project here."
                    : copies.length === 0
                      ? "Add a copy on a computer to work on it."
                      : webMode
                        ? "Turn on one of these computers to open it here."
                        : "The project opens here as soon as one is."}
              </span>
            </div>
          </div>
          {copies.length > 0 ? (
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
                    <button
                      type="button"
                      className="kit-btn"
                      data-size="sm"
                      disabled={manualConnectKey != null || autoOpen != null}
                      onClick={() => connectCopy(copy)}
                    >
                      {manualConnectKey != null && manualConnectKey === copy.machineKey ? "Connecting…" : wakeOrConnect}
                    </button>
                  ) : (
                    <span className="kit-tag shrink-0">{webMode ? webMachineOf(copy)?.statusLabel ?? "Offline" : "Offline"}</span>
                  )}
                </div>
                );
              })}
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
                title: "Couldn't add a copy on this computer",
                detail: failed.failure?.reason ?? undefined,
                report: { surface: "repository_tab_no_machine", code: "add_local_copy_failed" },
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canAddLocal ? (
              <button type="button" className="kit-btn kit-btn-primary" disabled={adding} onClick={addLocalCopy}>
                {adding ? "Adding a copy…" : "Add a copy on this computer"}
              </button>
            ) : null}
            {/* ADE Web has no connections panel; its rows above connect a computer. */}
            {webMode ? null : (
              <button type="button" className="kit-btn" onClick={() => openConnectionsPanel("machines")}>
                Connect a computer
              </button>
            )}
            <button
              type="button"
              className="kit-btn kit-btn-ghost"
              onClick={() => useAppStore.getState().closeNoMachineTab(tab.id)}
            >
              Close tab
            </button>
            {canLeaveAccount ? (
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                data-tone="crit"
                style={{ marginLeft: "auto" }}
                onClick={() => requestRemoveProject({ kind: "no-machine", id: tab.id, displayName: tab.displayName })}
              >
                Remove from account…
              </button>
            ) : null}
          </div>
        </div>
      </section>
      {githubRepoKey ? (
        <div className="flex w-full max-w-[460px] shrink-0 flex-col" style={{ height: 300 }}>
          <PullRequestsCard projectName={githubRepoTitle ?? githubRepoKey} projectRoot={githubRepoKey} prs={pullRequests} />
        </div>
      ) : null}
    </div>
  );
}

