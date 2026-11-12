import { useEffect, useMemo, useRef, useState } from "react";
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
import { useDirectHomePullRequests } from "./useDirectHomePullRequests";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { resolveMachinePresence } from "../../../shared/types/power";
import "./ProjectWelcomePage.css";

/** The repository tab of a no-machine tab: the account project when the account knows it. */
function repositoryTabOf(tab: NoMachineRepositoryTab, list: ReturnType<typeof useAccountProjectList>): RepositoryTab {
  const project = list.state === "ready" ? list.projects.find((entry) => entry.id === tab.id) : undefined;
  if (project) return repositoryTabFromAccountProject(project, { displayName: tab.displayName, iconDataUrl: tab.iconDataUrl });
  const address = tab.id.startsWith("repo:") ? tab.id.slice("repo:".length) : tab.id;
  return {
    kind: "account",
    id: tab.id,
    displayName: tab.displayName,
    iconDataUrl: tab.iconDataUrl,
    host: address.split("/")[0]?.toLowerCase() || "github.com",
    repoKeys: [tab.id.startsWith("repo:") ? tab.id : `repo:${address}`],
  };
}

function openCopy(copy: RepositoryCopy): Promise<unknown> {
  const address = copy.address;
  const store = useAppStore.getState();
  if (!address) return Promise.resolve();
  if (address.kind === "remote") return store.switchRemoteProject(address.targetId, address.projectId);
  return store.switchProjectToPath(address.rootPath, { skipWorktreeGate: true });
}

/**
 * The page of a repository tab with no computer online (0M, S4). It calls no
 * machine: it lists the copies the account knows and offers what can bring
 * one back. When a computer with a copy comes online, the tab opens that copy
 * by itself.
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
  const [openError, setOpenError] = useState<string | null>(null);
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
  const pullRequests = useDirectHomePullRequests(githubRepo);

  // A copy came online: open it. Once per copy, so a copy that fails to open
  // does not loop; the list still offers it.
  const tried = useRef(new Set<string>());
  const defaultAddress = resolveDefaultCopy({ copies });
  useEffect(() => {
    if (!defaultAddress || tried.current.has(defaultAddress.key)) return;
    tried.current.add(defaultAddress.key);
    const copy = copies.find((entry) => entry.address?.key === defaultAddress.key);
    if (copy) void openCopy(copy).catch(() => undefined);
  }, [copies, defaultAddress]);

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
   * long-gone computers), and the copy names its folder.
   */
  const webMachineFor = (copy: RepositoryCopy): WebMachineEntry | null => {
    const machine = copy.checkoutId ? webMachineOf(copy) : null;
    if (!machine) return null;
    const held = machine.status === "live" || machine.status === "connecting" || machine.status === "parked";
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
    const copyKey = `${copy.machineId}\n${copy.rootPath}`;
    setOpenError(null);
    setOpeningCopyKey(copyKey);
    void (async () => {
      try {
        const targetId = await workspace.connectMachineEntry(machine);
        await workspace.adapter.openProject(targetId, checkoutId);
        // The project is open now; leave this page as the desktop does when a copy opens.
        useAppStore.setState((state) => (state.activeNoMachineTabId === tab.id ? { activeNoMachineTabId: null } : {}));
        navigate(workspace.consumePendingProjectPath() ?? "/work");
      } catch {
        setOpenError(`${machine.name} did not answer. Try again, or open the project on another computer.`);
      } finally {
        setOpeningCopyKey((current) => (current === copyKey ? null : current));
      }
    })();
  };
  const webOpenable = webMode && copies.some((copy) => webMachineFor(copy) != null);

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
            {webOpenable ? (
              <Desktop size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--kit-text-3)" }} />
            ) : (
              <WifiSlash size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--kit-text-3)" }} />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-[13px] font-semibold">
                {webOpenable
                  ? "Open it on a computer"
                  : copies.length > 0 ? "No computer with this project is online" : "No computer has a copy yet"}
              </strong>
              <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>
                {webOpenable
                  ? "These computers have a copy. Pick one to work there."
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
                const copyKey = `${copy.machineId}\n${copy.rootPath}`;
                const webMachine = webMode ? webMachineFor(copy) : null;
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
                      disabled={openingCopyKey != null}
                      onClick={() => openOnWeb(copy, webMachine)}
                    >
                      {openingCopyKey === copyKey ? "Opening…" : "Open"}
                    </button>
                  ) : !webMode && copy.online && copy.address ? (
                    <button type="button" className="kit-btn" data-size="sm" onClick={() => void openCopy(copy).catch(() => undefined)}>
                      Open
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
            <span className="text-[12px]" role="alert" style={{ color: "var(--kit-crit)" }}>{openError}</span>
          ) : null}
          {failed ? (
            <span className="text-[12px]" style={{ color: "var(--kit-crit)" }}>
              The copy on this computer could not be added. {failed.failure?.reason ?? ""}
            </span>
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
          <PullRequestsCard projectName={githubRepoKey} projectRoot={githubRepoKey} prs={pullRequests} />
        </div>
      ) : null}
    </div>
  );
}

