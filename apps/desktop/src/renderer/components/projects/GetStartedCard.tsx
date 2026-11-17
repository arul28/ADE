import { useEffect, useMemo, useState } from "react";
import { GithubLogo, Laptop, Lock, X } from "@phosphor-icons/react";
import { SetupSteps, type SetupStep } from "./SetupSteps";
import { githubSignInFailureDetail, startGithubAccountAppSignIn, useGithubAccountApp } from "../../lib/useGithubAccountApp";
import { useAccountGithubRepositories } from "../../lib/useAccountGithubReads";
import { useAccountProjectList } from "../../state/useRepositoryCopies";
import { accountProjectListUserId } from "../../state/accountProjectListClient";
import { useAccountCloudLaunches } from "../../state/accountCloudLaunches";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { extractError } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";
import { addRepoToAccount, openAddedAccountProject } from "./useAddToAccount";

const DONE_KEY = "ade.getStarted.done.v1";
const INSTALL_CHIP_DISMISSED_KEY = "ade.getStarted.installChip.dismissed.v1";
/** Where a person with no computer of their own gets ADE. */
const ADE_DOWNLOAD_PAGE_URL = "https://ade-app.dev/";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // This browser's copy only; the card checks the steps again next time.
  }
}

/** Opens an account project's page (its repository tab, with no copy needed). */
function openAccountProject(project: { id: string; name: string }): void {
  useAppStore.getState().showNoMachineTab({ id: project.id, displayName: project.name, iconDataUrl: null });
}

/**
 * The state of the three first steps, from what the app already holds: the
 * account's GitHub sign-in, its project list, and its ADE Cloud chats.
 * `priorWork` counts as a first chat already sent (someone with projects on
 * a computer of their own never sees the card).
 */
export function useGetStartedState({ priorWork }: { priorWork: boolean | null }) {
  const github = useGithubAccountApp();
  const list = useAccountProjectList();
  const launches = useAccountCloudLaunches();
  const cloudLanes = useAdeCloudLaneComputers();
  // Finished once per account: another account in this browser starts over.
  const doneKey = `${DONE_KEY}:${accountProjectListUserId() ?? "unknown"}`;
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Finished stays finished on this page too: a step that later changes (GitHub disconnected) doesn't bring the card back.
  const doneBefore = useMemo(() => savedKey === doneKey || readFlag(doneKey), [doneKey, savedKey]);
  const projects = list.state === "ready" ? list.projects : [];
  const githubDone = github.connected;
  const projectDone = projects.length > 0;
  const chatDone = priorWork === true || launches.entries.some((entry) => Boolean(entry.record?.sessionId)) || cloudLanes.computers.length > 0;
  const allDone = githubDone && projectDone && chatDone;
  // Unknown is not "to do": the card waits for the reads before it shows.
  const known = github.loaded && list.state === "ready" && launches.known && priorWork != null;
  useEffect(() => {
    // Only once every read is in: a step still loading never counts as done for good.
    if (!allDone || !known || !accountProjectListUserId()) return;
    writeFlag(doneKey);
    setSavedKey(doneKey);
  }, [allDone, doneKey, known]);
  return {
    github,
    projects,
    githubDone,
    projectDone,
    chatDone,
    /** Show the card: the steps are read, not all done, and never finished before. */
    show: !doneBefore && known && !allDone,
    /** The steps were finished (now or before): the install chip may show. */
    finished: doneBefore || allDone,
  };
}

/**
 * "Get started with ADE" on Home: Connect GitHub, Add a project, Send your
 * first chat. It sits above the widgets until the first chat, then goes
 * away for good. Each step's action is on its row; the current step's row
 * is lit.
 */
export function GetStartedCard({
  state,
  onAddProject,
}: {
  state: ReturnType<typeof useGetStartedState>;
  /** Opens the Add project form. */
  onAddProject: () => void;
}) {
  const { github, projects, githubDone, projectDone, chatDone } = state;
  const repos = useAccountGithubRepositories(githubDone && !projectDone);
  const [addingRepo, setAddingRepo] = useState<string | null>(null);
  const recentRepos = useMemo(() => repos.repositories.slice(0, 3), [repos.repositories]);
  const connecting = github.phase.kind === "starting" || github.phase.kind === "waiting";

  const addRepo = async (repo: { fullName: string; htmlUrl: string | null; owner: string; name: string }) => {
    if (typeof window.ade?.project?.accountAdd !== "function") {
      onAddProject();
      return;
    }
    setAddingRepo(repo.fullName);
    try {
      const { answer, accountChanged } = await addRepoToAccount(repo.htmlUrl ?? `https://github.com/${repo.owner}/${repo.name}`);
      // Another account signed in while it ran: the project is not this account's.
      if (accountChanged) return;
      if (!answer.ok) {
        showToast({ tone: "error", title: `Couldn't add ${repo.name}`, message: answer.message });
        return;
      }
      openAddedAccountProject(answer.project);
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't add ${repo.name}`, message: extractError(error) });
    } finally {
      setAddingRepo(null);
    }
  };

  const firstProject = projects[0] ?? null;
  const steps: SetupStep[] = [
    {
      id: "github",
      title: github.status?.githubLogin && githubDone ? `GitHub connected as ${github.status.githubLogin}` : "Connect GitHub",
      hint: githubDone
        ? undefined
        : github.phase.kind === "failed"
          ? githubSignInFailureDetail(github.phase)
          : "ADE reads your repositories and opens pull requests with it.",
      state: githubDone ? "done" : connecting ? "running" : github.phase.kind === "failed" ? "failed" : "todo",
      action: githubDone ? undefined : (
        <button
          type="button"
          className="kit-btn kit-btn-primary"
          data-size="sm"
          disabled={connecting}
          onClick={() => void startGithubAccountAppSignIn(() => void github.refresh())}
        >
          <GithubLogo size={13} aria-hidden />
          {connecting ? "Waiting for GitHub…" : "Connect GitHub"}
        </button>
      ),
    },
    {
      id: "project",
      title: projectDone && firstProject ? `Added ${firstProject.owner}/${firstProject.name}` : "Add a project",
      hint: projectDone ? undefined : "Pick a repository. It stays on GitHub; ADE works on a copy.",
      state: projectDone ? "done" : "todo",
      action: projectDone ? undefined : (
        <button type="button" className={githubDone ? "kit-btn kit-btn-primary" : "kit-btn"} data-size="sm" onClick={onAddProject}>
          Add a project
        </button>
      ),
      detail: !projectDone && githubDone && recentRepos.length > 0 ? (
        <div className="ade-get-started-chips" aria-label="Recent repositories">
          {recentRepos.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              className="ade-repo-chip"
              disabled={addingRepo != null}
              title={`Add ${repo.fullName}`}
              onClick={() => void addRepo(repo)}
            >
              {repo.private ? <Lock size={11} aria-hidden /> : <GithubLogo size={11} aria-hidden />}
              <span>{addingRepo === repo.fullName ? `Adding ${repo.name}…` : repo.fullName}</span>
            </button>
          ))}
        </div>
      ) : undefined,
    },
    {
      id: "chat",
      title: "Send your first chat",
      hint: chatDone ? undefined : "The first message starts a computer on ADE Cloud for it.",
      state: chatDone ? "done" : "todo",
      action: chatDone || !firstProject ? undefined : (
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => openAccountProject(firstProject)}>
          Open {firstProject.name}
        </button>
      ),
    },
  ];

  return (
    <section className="kit-card ade-get-started" aria-label="Get started with ADE" data-testid="ade-get-started">
      <header className="kit-card-head">Get started with ADE</header>
      <div className="kit-card-body" style={{ paddingTop: 4 }}>
        <SetupSteps steps={steps} label="Get started with ADE" />
      </div>
    </section>
  );
}

/**
 * After the first chat, on a client with no computer of the person's own:
 * one quiet line that a computer joins by itself once ADE is installed on it.
 */
export function InstallAdeChip() {
  const [dismissed, setDismissed] = useState(() => readFlag(INSTALL_CHIP_DISMISSED_KEY));
  if (dismissed) return null;
  return (
    <div className="kit-panel flex items-center gap-2 px-3 py-1.5" style={{ maxWidth: 520, width: "100%", flex: "none" }} data-testid="ade-install-chip">
      <Laptop size={14} aria-hidden style={{ color: "var(--kit-text-3)", flex: "none" }} />
      <span className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
        Have a computer? Install ADE and it shows up here by itself.
      </span>
      <button
        type="button"
        className="kit-btn kit-btn-ghost"
        data-size="sm"
        onClick={() => openExternalUrl(ADE_DOWNLOAD_PAGE_URL)}
      >
        Get ADE
      </button>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label="Hide"
        onClick={() => {
          writeFlag(INSTALL_CHIP_DISMISSED_KEY);
          setDismissed(true);
        }}
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}
