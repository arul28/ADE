import { useMemo, useState, type ReactNode } from "react";
import { ArrowSquareOut, CaretRight, File, FolderSimple, GitBranch, GitPullRequest, Circle } from "@phosphor-icons/react";
import type { GithubDirectError, GithubDirectRepoRef } from "../../../shared/types";
import { ADE_GITHUB_APP_INSTALL_URL, githubDirectStateCopy } from "../../../shared/github/githubDirectStateCopy";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { openExternalUrl } from "../../lib/openExternal";
import { startGithubAccountAppSignIn, useGithubAccountApp } from "../../lib/useGithubAccountApp";
import {
  useAccountGithubBranches,
  useAccountGithubContents,
  useAccountGithubDiagnosis,
  useAccountGithubIssues,
  useAccountGithubPulls,
} from "../../lib/useAccountGithubReads";
import { launchInProgress, startAccountCloudChat, type AccountCloudLaunchEntry } from "../../state/accountCloudLaunches";
import type { AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import {
  catalogSignInKind,
  defaultCloudModel,
  saveLastCloudModel,
  useCloudModelCatalog,
  type CloudModelPick,
} from "../../state/cloudModelCatalog";
import { Banner } from "../ui/notice";
import { SetupSteps, type SetupStep } from "./SetupSteps";

/* ---- GitHub access ---- */

/**
 * Whether the account's GitHub sign-in can reach the repository:
 * - `unknown`: still reading, or the reads are not available here;
 * - `no_github`: the account has no GitHub sign-in;
 * - `no_access`: the ADE app is not on the owner, or this repository is not in it;
 * - `ok`: reads and clones work.
 */
export type GithubAccess = { state: "unknown" | "no_github" | "no_access" | "ok"; installUrl: string };

export function useGithubAccess(repo: GithubDirectRepoRef | null): GithubAccess {
  const github = useGithubAccountApp();
  const { diagnosis } = useAccountGithubDiagnosis(github.connected ? repo : null);
  if (!repo) return { state: "unknown", installUrl: ADE_GITHUB_APP_INSTALL_URL };
  if (!github.connected) return { state: github.loaded ? "no_github" : "unknown", installUrl: ADE_GITHUB_APP_INSTALL_URL };
  const installUrl = diagnosis?.error?.manageUrl ?? ADE_GITHUB_APP_INSTALL_URL;
  if (!diagnosis) return { state: "unknown", installUrl };
  switch (diagnosis.state) {
    case "ok":
    case "rights_not_accepted":
      return { state: "ok", installUrl };
    case "not_connected":
    case "sign_in_expired":
      return { state: "no_github", installUrl };
    default:
      // `read_only` (public, no install) clones but cannot push: it needs the app too.
      return { state: "no_access", installUrl };
  }
}

/* ---- Steps strip ---- */

/**
 * The project page's slim steps strip: GitHub access, the first chat, lanes.
 * Hidden once every step is done.
 */
export function AccountProjectSteps({
  owner,
  access,
  launches,
  laneCount,
}: {
  owner: string | null;
  access: GithubAccess;
  launches: readonly AccountCloudLaunchEntry[];
  laneCount: number;
}) {
  const chatRunning = launches.some(launchInProgress);
  const chatDone = laneCount > 0 || launches.some((entry) => Boolean(entry.record?.sessionId));
  if (access.state === "ok" && chatDone && laneCount > 0) return null;
  const steps: SetupStep[] = [
    {
      id: "access",
      title: "GitHub access",
      state: access.state === "ok" ? "done" : access.state === "unknown" ? "running" : "todo",
      action: access.state === "no_github" ? (
        <button type="button" className="kit-btn" data-size="sm" onClick={() => void startGithubAccountAppSignIn(() => undefined)}>
          Connect GitHub
        </button>
      ) : access.state === "no_access" ? (
        <button type="button" className="kit-btn" data-size="sm" onClick={() => openExternalUrl(access.installUrl)}>
          Give ADE access to {owner ?? "the owner"}
        </button>
      ) : undefined,
    },
    { id: "chat", title: "First chat", state: chatDone ? "done" : chatRunning ? "running" : "todo" },
    { id: "lanes", title: "Lanes", state: laneCount > 0 ? "done" : "todo" },
  ];
  return <SetupSteps steps={steps} layout="strip" label="Project setup" />;
}

/* ---- Composer ---- */

/**
 * The first message of a chat on ADE Cloud: it makes the computer. The
 * message waits on the server while the computer starts, so the tab may
 * close. The model starts on the last one used.
 */
export function CloudChatComposer({
  accountProjectId,
  origin,
  owner,
  access,
}: {
  accountProjectId: string;
  origin: string;
  owner: string | null;
  access: GithubAccess;
}) {
  const { catalog, error: catalogError, loading, retry } = useCloudModelCatalog(true);
  const [pick, setPick] = useState<CloudModelPick | null>(null);
  const current = pick ?? defaultCloudModel(catalog);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const provider = catalog?.providers.find((entry) => entry.provider === current?.provider) ?? null;
  const desktopOnly = provider ? catalogSignInKind(provider) === "desktop" : false;
  // The server decides: a public repo clones without GitHub, a private one answers "Give ADE access".
  const needsAccess = access.state === "no_github" || access.state === "no_access";
  const canSend = text.trim().length > 0 && current != null && !sending && !desktopOnly;

  const send = () => {
    if (!canSend || !current) return;
    setSending(true);
    setSendError(null);
    saveLastCloudModel(current);
    void startAccountCloudChat({ accountProjectId, origin, provider: current.provider, modelId: current.modelId, prompt: text.trim() })
      .then(() => setText(""))
      .catch((error: unknown) => setSendError(error instanceof Error ? error.message : String(error)))
      .finally(() => setSending(false));
  };

  return (
    <section className="kit-card w-full" aria-label="New chat">
      <div className="kit-card-body flex flex-col gap-2" style={{ paddingTop: 10 }}>
        <textarea
          className="kit-input"
          rows={3}
          style={{ resize: "vertical", minHeight: 72, height: "auto", padding: "8px 10px", lineHeight: 1.45 }}
          placeholder="What should the agent do?"
          aria-label="What should the agent do?"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="kit-input"
            data-size="sm"
            style={{ width: "auto", maxWidth: 260 }}
            aria-label="Model"
            disabled={!catalog}
            value={current ? `${current.provider}\n${current.modelId}` : ""}
            onChange={(event) => {
              const [nextProvider, modelId] = event.target.value.split("\n");
              if (nextProvider && modelId) setPick({ provider: nextProvider, modelId });
            }}
          >
            {!catalog ? <option value="">{loading ? "Loading models…" : "No models"}</option> : null}
            {catalog?.providers.map((entry) => (
              <optgroup key={entry.provider} label={entry.label}>
                {entry.models.map((model) => (
                  <option key={model.id} value={`${entry.provider}\n${model.id}`}>{model.displayName}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>Runs on ADE Cloud</span>
          <button type="button" className="kit-btn kit-btn-primary" style={{ marginLeft: "auto" }} disabled={!canSend} onClick={send}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
        {desktopOnly ? (
          <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-2)" }}>
            {provider?.label ?? "This provider"} signs in from ADE desktop. Sign in there, or pick another model.
          </p>
        ) : needsAccess ? (
          <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>
            {access.state === "no_github"
              ? "A private repo needs GitHub connected first."
              : `A private repo needs ADE to have access to ${owner ?? "its owner"} first.`}
          </p>
        ) : null}
        {catalogError ? (
          <Banner
            layout="inline"
            model={{
              id: "cloud-models-unavailable",
              tone: "error",
              title: "Couldn't load the models",
              actions: [{ label: "Try again", onClick: retry }],
              report: { surface: "account_project_composer", code: "cloud_models_unavailable", technicalDetail: catalogError },
            }}
          />
        ) : null}
        {sendError ? (
          <Banner
            layout="inline"
            model={{
              id: "cloud-chat-send",
              tone: "error",
              title: "Couldn't send the message",
              detail: sendError,
              report: { surface: "account_project_composer", code: "cloud_chat_start_failed", technicalDetail: sendError },
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/* ---- Lanes ---- */

export type AccountProjectLane = {
  key: string;
  name: string;
  where: string;
  state: string;
  onOpen: (() => void) | null;
};

/** The project's cloud lanes (from the account) and lanes that are starting now. */
export function cloudLanesOfOrigin(
  computers: readonly AdeCloudLaneComputer[],
  launches: readonly AccountCloudLaunchEntry[],
  origin: string | null,
): Array<{ laneId: string; laneName: string; computer: AdeCloudLaneComputer | null; launch: AccountCloudLaunchEntry | null }> {
  const identity = normalizeGitRemoteIdentity(origin);
  if (!identity) return [];
  const rows = new Map<string, { laneId: string; laneName: string; computer: AdeCloudLaneComputer | null; launch: AccountCloudLaunchEntry | null }>();
  for (const computer of computers) {
    if (normalizeGitRemoteIdentity(computer.projectOrigin) !== identity || computer.state === "deleting") continue;
    rows.set(computer.laneId, { laneId: computer.laneId, laneName: computer.laneName, computer, launch: null });
  }
  for (const launch of launches) {
    const laneId = launch.record?.laneId;
    const laneName = launch.record?.laneName;
    if (!laneId || !laneName || launch.record?.state === "cancelled" || launch.record?.state === "failed") continue;
    const row = rows.get(laneId);
    rows.set(laneId, row ? { ...row, launch } : { laneId, laneName, computer: null, launch });
  }
  return [...rows.values()];
}

export function ProjectLanesCard({ lanes }: { lanes: readonly AccountProjectLane[] }) {
  return (
    <section className="kit-card w-full" aria-label="Lanes">
      <header className="kit-card-head">
        <GitBranch size={13} aria-hidden />
        Lanes
      </header>
      <div className="kit-card-body" style={{ paddingTop: 2 }}>
        {lanes.length === 0 ? (
          <p className="m-0 py-2 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
            Lanes show here after your first chat. Each chat gets its own lane.
          </p>
        ) : (
          <div role="list" className="flex flex-col">
            {lanes.map((lane) => (
              <div key={lane.key} role="listitem" className="kit-row">
                <GitBranch size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px]">{lane.name}</span>
                  <span className="truncate text-[11px]" style={{ color: "var(--kit-text-3)" }}>{lane.where}</span>
                </span>
                <span className="kit-tag shrink-0">{lane.state}</span>
                {lane.onOpen ? (
                  <button type="button" className="kit-btn" data-size="sm" onClick={lane.onOpen}>Open</button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---- GitHub tabs ---- */

type GithubTab = "pulls" | "issues" | "branches" | "files";
const GITHUB_TABS: ReadonlyArray<{ id: GithubTab; label: string }> = [
  { id: "pulls", label: "Pull requests" },
  { id: "issues", label: "Issues" },
  { id: "branches", label: "Branches" },
  { id: "files", label: "Files" },
];

function GithubReadState({ error, repo, items, loading, empty }: {
  error: GithubDirectError | null;
  repo: GithubDirectRepoRef;
  items: "pull requests" | "issues";
  loading: boolean;
  empty: string | null;
}): ReactNode {
  if (error) {
    const copy = githubDirectStateCopy(error, { owner: repo.owner, name: repo.name, items });
    if (copy) {
      return (
        <div className="flex flex-col gap-1 py-2">
          <strong className="text-[12.5px] font-semibold">{copy.title}</strong>
          <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>{copy.body}</span>
          {copy.primary ? (
            <span>
              <button
                type="button"
                className="kit-btn"
                data-size="sm"
                onClick={() => (copy.primary!.kind === "link" ? openExternalUrl(copy.primary!.url) : void startGithubAccountAppSignIn(() => undefined))}
              >
                {copy.primary.label}
              </button>
            </span>
          ) : null}
        </div>
      );
    }
  }
  if (loading) return <p className="m-0 py-2 text-[12px]" style={{ color: "var(--kit-text-3)" }}>Loading…</p>;
  return empty ? <p className="m-0 py-2 text-[12px]" style={{ color: "var(--kit-text-2)" }}>{empty}</p> : null;
}

function LinkRow({ icon, title, meta, url, onClick }: { icon: ReactNode; title: string; meta?: string | null; url?: string | null; onClick?: () => void }) {
  return (
    <button type="button" role="listitem" className="kit-row" onClick={onClick ?? (() => openExternalUrl(url ?? null))} disabled={!onClick && !url}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta ? <span className="shrink-0 text-[11px]" style={{ color: "var(--kit-text-3)" }}>{meta}</span> : null}
    </button>
  );
}

function PullsTab({ repo }: { repo: GithubDirectRepoRef }) {
  const { pulls, error, loading } = useAccountGithubPulls(repo);
  if (pulls.length === 0) return <GithubReadState error={error} repo={repo} items="pull requests" loading={loading} empty="No open pull requests." />;
  return (
    <div role="list" className="flex flex-col">
      {pulls.slice(0, 30).map((pull) => (
        <LinkRow
          key={pull.number}
          icon={<GitPullRequest size={13} aria-hidden style={{ color: pull.draft ? "var(--kit-text-3)" : "var(--color-accent)" }} />}
          title={pull.title}
          meta={`#${pull.number}${pull.draft ? " · Draft" : ""}`}
          url={pull.htmlUrl}
        />
      ))}
    </div>
  );
}

function IssuesTab({ repo }: { repo: GithubDirectRepoRef }) {
  const { issues, error, loading } = useAccountGithubIssues(repo);
  if (issues.length === 0) return <GithubReadState error={error} repo={repo} items="issues" loading={loading} empty="No open issues." />;
  return (
    <div role="list" className="flex flex-col">
      {issues.slice(0, 30).map((issue) => (
        <LinkRow key={issue.number} icon={<Circle size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />} title={issue.title} meta={`#${issue.number}`} url={issue.htmlUrl} />
      ))}
    </div>
  );
}

function BranchesTab({ repo, defaultBranch, githubUrl }: { repo: GithubDirectRepoRef; defaultBranch: string | null; githubUrl: string }) {
  const { branches, error, loading } = useAccountGithubBranches(repo);
  const sorted = useMemo(
    () => branches.slice().sort((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch) || a.name.localeCompare(b.name)),
    [branches, defaultBranch],
  );
  if (sorted.length === 0) return <GithubReadState error={error} repo={repo} items="pull requests" loading={loading} empty="No branches." />;
  return (
    <div role="list" className="flex flex-col">
      {sorted.slice(0, 50).map((branch) => (
        <LinkRow
          key={branch.name}
          icon={<GitBranch size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />}
          title={branch.name}
          meta={branch.name === defaultBranch ? "Default" : branch.protected ? "Protected" : null}
          url={`${githubUrl}/tree/${branch.name.split("/").map(encodeURIComponent).join("/")}`}
        />
      ))}
    </div>
  );
}

function FilesTab({ repo }: { repo: GithubDirectRepoRef }) {
  const [path, setPath] = useState("");
  const { entries, error, loading } = useAccountGithubContents(repo, path);
  const parts = path ? path.split("/") : [];
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-0.5 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => setPath("")}>{repo.name}</button>
        {parts.map((part, index) => (
          <span key={`${index}-${part}`} className="flex items-center gap-0.5">
            <CaretRight size={10} aria-hidden />
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>{part}</button>
          </span>
        ))}
      </nav>
      {entries.length === 0 ? (
        <GithubReadState error={error} repo={repo} items="pull requests" loading={loading} empty="This folder is empty." />
      ) : (
        <div role="list" className="flex flex-col">
          {entries.map((entry) => (
            <LinkRow
              key={entry.path}
              icon={entry.kind === "dir"
                ? <FolderSimple size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />
                : <File size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />}
              title={entry.name}
              url={entry.htmlUrl}
              onClick={entry.kind === "dir" ? () => setPath(entry.path) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Pull requests, issues, branches and files, read from GitHub with the account's sign-in. */
export function GithubTabsCard({ repo, defaultBranch }: { repo: GithubDirectRepoRef; defaultBranch: string | null }) {
  const [tab, setTab] = useState<GithubTab>("pulls");
  const githubUrl = `https://github.com/${repo.owner}/${repo.name}`;
  return (
    <section className="kit-card w-full" aria-label="On GitHub">
      <header className="kit-card-head" style={{ gap: 8 }}>
        <div className="kit-seg" data-case="sentence" role="tablist" aria-label="GitHub">
          {GITHUB_TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="kit-card-head-action" onClick={() => openExternalUrl(githubUrl)}>
          GitHub <ArrowSquareOut size={11} aria-hidden />
        </button>
      </header>
      <div className="kit-card-body" role="tabpanel" style={{ paddingTop: 2, maxHeight: 360, overflowY: "auto" }}>
        {tab === "pulls" ? <PullsTab repo={repo} /> : null}
        {tab === "issues" ? <IssuesTab repo={repo} /> : null}
        {tab === "branches" ? <BranchesTab repo={repo} defaultBranch={defaultBranch} githubUrl={githubUrl} /> : null}
        {tab === "files" ? <FilesTab repo={repo} /> : null}
      </div>
    </section>
  );
}
