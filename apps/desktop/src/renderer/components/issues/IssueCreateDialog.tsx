import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildJiraLaunchIssue } from "../../lib/linearBatchLaunch";
import { requestIssueLaunch } from "../../lib/issueLaunchRequests";
import { CircleNotch, DotsThree, GithubLogo, Image as ImageIcon, X } from "@phosphor-icons/react";
import type { GitHubIssueAttachmentInput, LinearIssueCreateOptions, LinearProjectMilestone } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import type { GitHubIssueFormAnswers, GitHubIssueTemplate } from "../../../shared/githubIssueTemplates";
import { isMacRuntimeTarget } from "../../lib/platform";
import { openIssueRef } from "../../lib/issueNavigation";
import { requestLinearIssueLaunch } from "../../lib/linearLaunchRequests";
import { announceIssueCreated, type IssueCreateRequest } from "../../lib/issueCreateRequests";
import { showToast } from "../app/toast/toastStore";
import { LinearMark } from "../lanes/linearBrand";
import { JiraMark } from "../lanes/jiraBrand";
import { Dialog } from "../ui/dialog";
import { Banner, noticeKindModel, type NoticeKind } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { GitHubIssueFormFields } from "./GitHubIssueFormFields";
import {
  loadGitHubRepoCatalog,
  noteGitHubIssueCreated,
  useGitHubCreateCatalog,
  useGitHubRepoCatalog,
  useProjectGitHubRepo,
} from "./githubIssueStore";
import { requestGitHubIssueLaunch } from "./githubIssueLaunch";
import {
  GitHubCreateChips,
  GitHubMoreFields,
  JiraCreateChips,
  JiraMoreFields,
  LinearCreateChips,
  LinearMoreFields,
  linearTeamProjects,
} from "./issueCreateChips";
import { ChipPicker } from "./issuePickerChip";
import {
  initialIssueForm,
  rememberIssueProvider,
  writeIssueDraft,
  type GitHubFields,
  type JiraFields,
  type IssueDraft,
  type IssueProvider,
  type LinearFields,
} from "./issueCreateDraft";
import { submitGitHubIssue, submitJiraIssue, submitLinearIssue } from "./issueCreateSubmit";
import type { PickerOption } from "./IssuePickerMenu";
import { useActiveProjectRoot } from "../../state/appStore";
import { useLinearPickerCatalog } from "./linearIssueStore";
import { useSimilarIssues } from "./useSimilarIssues";
import type { JiraCreateMeta, JiraUser } from "../../../shared/types/jira";
import {
  loadJiraAssignableUsers,
  loadJiraCreateMeta,
  loadJiraIssue,
  loadJiraLabels,
  loadJiraProjects,
  noteJiraIssueCreated,
  useJiraConnectionStatus,
  useJiraProjects,
} from "./jiraIssueStore";
import { extractError } from "../../lib/format";

/**
 * Starting a new issue in Linear, GitHub or Jira, in one composer: a big title, the
 * description, a row of property chips (the same pickers the viewer uses), and
 * a `⋯` row for the fields most issues skip. Templates fill it in; a GitHub
 * issue form replaces the description with its own fields.
 *
 * - The draft is saved per tracker and project while you type, and cleared on
 *   create (`issueCreateDraft.ts`).
 * - Pictures pasted or dropped into the description upload to Linear at once,
 *   or go to GitHub with the issue through `gh --attach`.
 * - Similar open issues ADE already read show under the title, without a
 *   request, so a duplicate is caught before it is filed.
 * - An issue started from a chat gets a "Context" footer linking back to it.
 */

const MOD = () => (isMacRuntimeTarget() ? "⌘" : "Ctrl");

/**
 * One coarse product fact per issue made here: which tracker it went to.
 * Captured after the tracker accepted it. A burst ("Create more") counts once a
 * minute per tracker, inside the `ade_feature_used` 140-per-day / 30-per-minute
 * limits. Nothing about the issue itself crosses the boundary.
 */
function captureIssueCreated(provider: IssueProvider): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: {
      feature: "issues",
      action: "issue_created",
      outcome: provider === "linear" ? "tracker_linear" : provider === "github" ? "tracker_github" : "tracker_jira",
      source: "renderer_route",
    },
    dedupeKey: `issue_created:${provider}`,
    minimumIntervalMs: 60_000,
  }).catch(() => undefined);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
}

export function IssueCreateDialog({ request, onClose }: { request: IssueCreateRequest; onClose: () => void }) {
  const projectRoot = useActiveProjectRoot();
  const parent = request.prefill?.parent ?? null;
  const jiraParent = parent?.provider === "jira" ? parent : null;
  // One read of the draft for the whole form, keyed to this project.
  const [initial] = useState(() => initialIssueForm(request, projectRoot));
  const [provider, setProvider] = useState<IssueProvider>(initial.provider);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [linear, setLinear] = useState<LinearFields>(initial.linear);
  const [github, setGitHub] = useState<GitHubFields>(initial.github);
  const [jira, setJira] = useState<JiraFields>(initial.jira);
  const [formAnswers, setFormAnswers] = useState<GitHubIssueFormAnswers>(initial.formAnswers);
  const draftRef = useRef<IssueDraft | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const [attachments, setAttachments] = useState<GitHubIssueAttachmentInput[]>([]);
  const [uploads, setUploads] = useState(0);
  const [showMore, setShowMore] = useState(() => Boolean(parent));
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<{ message: string; kind: NoticeKind } | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Remember the tracker, and keep the draft, as the user types.
  useEffect(() => {
    rememberIssueProvider(provider);
  }, [provider]);
  useEffect(() => {
    draftRef.current = { title, body, linear, github, jira, formAnswers };
    const timer = window.setTimeout(() => writeIssueDraft(provider, projectRoot, draftRef.current), 400);
    return () => window.clearTimeout(timer);
  }, [body, formAnswers, github, jira, linear, projectRoot, provider, title]);
  // Closing inside the 400 ms window must not lose the last keystrokes. A
  // create clears `draftRef` first, so nothing is written back after it.
  useEffect(() => () => {
    if (draftRef.current) writeIssueDraft(providerRef.current, projectRoot, draftRef.current);
  }, [projectRoot]);

  /* Linear data */
  const catalog = useLinearPickerCatalog();
  const teams = useMemo(() => {
    const byKey = new Map<string, { key: string; id: string; name: string }>();
    for (const state of catalog?.states ?? []) {
      if (!state.teamKey || byKey.has(state.teamKey)) continue;
      const project = catalog?.projects.find((entry) => entry.teamKey === state.teamKey);
      byKey.set(state.teamKey, { key: state.teamKey, id: state.teamId, name: project?.teamName ?? state.teamKey });
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [catalog]);
  const teamKey = linear.teamKey && teams.some((team) => team.key === linear.teamKey) ? linear.teamKey : teams[0]?.key ?? null;
  const [createOptions, setCreateOptions] = useState<LinearIssueCreateOptions | null>(null);
  useEffect(() => {
    if (provider !== "linear" || !teamKey) return;
    let cancelled = false;
    setCreateOptions(null);
    void window.ade?.cto?.getLinearIssueCreateOptions?.({ teamKey })
      .then((options) => { if (!cancelled) setCreateOptions(options); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [provider, teamKey]);
  const [milestones, setMilestones] = useState<LinearProjectMilestone[]>([]);
  useEffect(() => {
    if (!linear.projectId) {
      setMilestones([]);
      return;
    }
    let cancelled = false;
    void window.ade?.cto?.listLinearProjectMilestones?.({ projectId: linear.projectId })
      .then((list) => { if (!cancelled) setMilestones(list ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [linear.projectId]);

  /* GitHub data */
  // A sub-issue goes where its parent is, which need not be this project's repo.
  const { repo: projectRepo } = useProjectGitHubRepo();
  const parentRepo = useMemo(
    () => (parent?.provider === "github" ? { owner: parent.owner, name: parent.repo } : null),
    [parent],
  );
  const repo = parentRepo ?? projectRepo;
  const repoCatalog = useGitHubRepoCatalog(provider === "github" ? repo : null);
  const createCatalog = useGitHubCreateCatalog(provider === "github" ? repo : null);
  useEffect(() => {
    if (provider === "github" && repo) loadGitHubRepoCatalog(repo);
  }, [provider, repo]);
  const templates = createCatalog.templates?.templates ?? [];
  const template: GitHubIssueTemplate | null = templates.find((entry) => entry.key === github.templateKey) ?? null;
  const formTemplate = template?.kind === "form" ? template : null;
  const templateRequired = provider === "github" && createCatalog.templates?.blankIssuesEnabled === false && templates.length > 0;

  /* Jira data */
  const jiraConnection = useJiraConnectionStatus(provider === "jira");
  const jiraProjects = useJiraProjects(provider === "jira" && jiraConnection.status?.connected === true, jiraConnection.status?.siteUrl ?? "");
  const [jiraMeta, setJiraMeta] = useState<JiraCreateMeta | null>(null);
  const [jiraMetaError, setJiraMetaError] = useState<string | null>(null);
  const [jiraUsers, setJiraUsers] = useState<JiraUser[]>([]);
  const [jiraLabels, setJiraLabels] = useState<string[]>([]);
  const [jiraCatalogError, setJiraCatalogError] = useState<string | null>(null);
  const [jiraBoundProjectKeys, setJiraBoundProjectKeys] = useState<string[]>([]);
  const [jiraBindingLoaded, setJiraBindingLoaded] = useState(false);
  const [jiraBindingError, setJiraBindingError] = useState<string | null>(null);
  const [jiraBindingRetry, setJiraBindingRetry] = useState(0);
  const [jiraProjectsLoaded, setJiraProjectsLoaded] = useState(false);
  const jiraProjectDefaulted = useRef(false);
  const jiraProjectTouched = useRef(false);
  useEffect(() => {
    if (provider !== "jira") return;
    let cancelled = false;
    setJiraBindingLoaded(false);
    setJiraBindingError(null);
    void window.ade.projectConfig.get()
      .then((snapshot) => {
        if (cancelled) return;
        setJiraBoundProjectKeys(snapshot.effective.issueTrackers?.jira?.projectKeys ?? []);
        setJiraBindingLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setJiraBindingError(error instanceof Error ? error.message : "Couldn't load this project's Jira settings.");
        setJiraBindingLoaded(true);
      });
    return () => { cancelled = true; };
  }, [jiraBindingRetry, projectRoot, provider]);
  useEffect(() => {
    const siteUrl = jiraConnection.status?.siteUrl;
    if (provider !== "jira" || !jiraConnection.status?.connected || !siteUrl) {
      setJiraProjectsLoaded(false);
      return;
    }
    let cancelled = false;
    setJiraProjectsLoaded(false);
    void loadJiraProjects(projectRoot, { siteUrl }).then(() => {
      if (!cancelled) setJiraProjectsLoaded(true);
    }).catch(() => {
      if (!cancelled) setJiraProjectsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [jiraConnection.status?.connected, jiraConnection.status?.siteUrl, projectRoot, provider]);
  useEffect(() => {
    if (provider !== "jira" || !jiraProjectsLoaded || !jiraBindingLoaded || jiraProjectDefaulted.current) return;
    jiraProjectDefaulted.current = true;
    if (jiraProjectTouched.current) return;
    const boundProjectKey = jiraBoundProjectKeys[0];
    const lastUsedProjectKey = jiraProjects.projects.some((entry) => entry.key === jira.projectKey) ? jira.projectKey : null;
    const projectKey = boundProjectKey ?? lastUsedProjectKey ?? jiraProjects.projects[0]?.key;
    if (projectKey && projectKey !== jira.projectKey) {
      setJira((current) => ({ ...current, projectKey, issueTypeId: "", assigneeAccountId: null, priorityId: null, labels: [] }));
    }
  }, [jira.projectKey, jiraBindingLoaded, jiraBoundProjectKeys, jiraProjects.projects, jiraProjectsLoaded, provider]);
  useEffect(() => {
    if (provider !== "jira" || !jiraConnection.status?.connected || !jira.projectKey) {
      setJiraMeta(null);
      setJiraUsers([]);
      setJiraLabels([]);
      return;
    }
    let cancelled = false;
    setJiraMeta(null);
    setJiraMetaError(null);
    setJiraCatalogError(null);
    void loadJiraCreateMeta(projectRoot, jira.projectKey).then((meta) => {
      if (cancelled) return;
      setJiraMeta(meta);
      setJira((current) => {
        if (current.issueTypeId && meta?.issueTypes.some((entry) => entry.id === current.issueTypeId)) return current;
        const firstSupported = meta?.issueTypes.find((entry) => !entry.fields.some((field) => field.required && !field.supported));
        return { ...current, issueTypeId: firstSupported?.id ?? "" };
      });
    }).catch((error: unknown) => {
      if (!cancelled) setJiraMetaError(error instanceof Error ? error.message : "Couldn't load Jira issue types.");
    });
    void Promise.all([
      loadJiraAssignableUsers(projectRoot, { projectKey: jira.projectKey }),
      loadJiraLabels(projectRoot),
    ]).then(([users, labels]) => {
      if (!cancelled) { setJiraUsers(users); setJiraLabels(labels); }
    }).catch((error: unknown) => {
      if (!cancelled) setJiraCatalogError(error instanceof Error ? error.message : "Couldn't load Jira fields.");
    });
    return () => { cancelled = true; };
  }, [jira.projectKey, jiraConnection.status?.connected, projectRoot, provider]);
  const refreshJiraProjects = useCallback(() => { void jiraProjects.refresh().catch(() => undefined); }, [jiraProjects.refresh]);

  const applyGitHubTemplate = (next: GitHubIssueTemplate | null) => {
    setGitHub((current) => ({
      ...current,
      templateKey: next?.key ?? null,
      labels: next ? [...new Set([...current.labels, ...next.labels])] : current.labels,
      assignees: next ? [...new Set([...current.assignees, ...next.assignees])] : current.assignees,
      type: next?.type ?? current.type,
    }));
    if (next?.title && !title.trim()) setTitle(next.title);
    if (next?.kind === "markdown" && next.body && !body.trim()) setBody(next.body);
    if (next?.kind === "form") {
      const answers: GitHubIssueFormAnswers = {};
      next.fields.forEach((field, index) => {
        if ((field.type === "input" || field.type === "textarea") && field.value) answers[index] = field.value;
        if (field.type === "dropdown" && field.defaultIndex != null && field.options[field.defaultIndex]) {
          answers[index] = [field.options[field.defaultIndex]!];
        }
      });
      setFormAnswers(answers);
    }
  };

  const applyLinearTemplate = (templateId: string | null) => {
    const next = createOptions?.templates.find((entry) => entry.id === templateId) ?? null;
    setLinear((current) => ({
      ...current,
      templateId,
      priority: next?.priority ?? current.priority,
      labelIds: next ? [...new Set([...current.labelIds, ...next.labelIds])] : current.labelIds,
    }));
    if (next?.title && !title.trim()) setTitle(next.title);
  };

  /* Similar issues, from what ADE already read */
  const similar = useSimilarIssues(provider === "linear" ? "linear" : "github", provider === "github" ? repo : null, title);

  /* Pictures */
  const insertAtCursor = useCallback((text: string) => {
    const element = bodyRef.current;
    setBody((current) => {
      if (!element) return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${text}`;
      const start = element.selectionStart ?? current.length;
      const end = element.selectionEnd ?? current.length;
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
  }, []);

  const addPictures = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (provider === "github") {
      const next = await Promise.all(files.map(async (file) => ({
        filename: file.name || "image.png",
        contentType: file.type || "image/png",
        dataBase64: await fileToBase64(file),
      })));
      setAttachments((current) => [...current, ...next].slice(0, 10));
      return;
    }
    if (provider === "jira") {
      setError({ message: "Jira image attachments are not available here. Add a link in the description instead.", kind: "hint" });
      return;
    }
    const upload = window.ade?.cto?.uploadLinearFile;
    if (!upload) {
      setError({ message: "Uploading pictures to Linear is not available here.", kind: "status" });
      return;
    }
    for (const file of files) {
      setUploads((count) => count + 1);
      try {
        const result = await upload({ filename: file.name || "image.png", contentType: file.type || "image/png", dataBase64: await fileToBase64(file) });
        insertAtCursor(`![${result.filename}](${result.assetUrl})\n`);
      } catch (cause) {
        setError({ message: cause instanceof Error ? cause.message : "Linear refused the picture.", kind: "failure" });
      } finally {
        setUploads((count) => count - 1);
      }
    }
  }, [insertAtCursor, provider]);

  /* Create */
  const contextFooter = useMemo(() => {
    const sessionId = request.context?.sessionId;
    if (!sessionId) return "";
    const chatLink = buildDeeplink({ kind: "session", sessionId, ...(request.context?.laneId ? { laneId: request.context.laneId } : {}) });
    const lane = request.context?.laneName ? ` in lane **${request.context.laneName}**` : "";
    return `\n\n<details><summary>Context</summary>\n\nStarted from [an ADE chat](${chatLink})${lane}.\n\n</details>`;
  }, [request.context]);

  const reset = () => {
    setTitle("");
    setBody("");
    setFormAnswers({});
    setAttachments([]);
    setError(null);
    draftRef.current = null;
    writeIssueDraft(provider, projectRoot, null);
    titleRef.current?.focus();
  };

  const submit = async () => {
    if (busy || uploads > 0) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError({ message: "Give the issue a title.", kind: "hint" });
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (provider === "linear") {
        const issue = await submitLinearIssue({ teamKey, title: trimmed, description: `${body}${contextFooter}`, fields: linear });
        showToast({
          tone: "success",
          title: `Created ${issue.identifier}`,
          message: issue.title,
          actions: [{ label: "Start lane", onClick: () => requestLinearIssueLaunch({ issues: [issue], laneOnly: false }) }],
        });
        captureIssueCreated("linear");
        announceIssueCreated({ provider: "linear", issue });
        if (!createMore && request.origin !== "pane") {
          openIssueRef({ ref: { provider: "linear", identifier: issue.identifier, url: issue.url }, source: "issue-viewer" });
        }
      } else {
        if (provider === "jira") {
          if (!jiraConnection.status?.connected || !jiraConnection.status.siteUrl) {
            throw new Error("Connect Jira in Settings before creating an issue.");
          }
          const siteUrl = jiraConnection.status.siteUrl;
          const created = await submitJiraIssue({ title: trimmed, description: `${body}${contextFooter}`, fields: jira, meta: jiraMeta });
          announceIssueCreated({
            provider: "jira",
            siteUrl: jiraConnection.status.siteUrl,
            key: created.key,
            projectKey: jira.projectKey,
          });
          void loadJiraIssue(projectRoot, { provider: "jira", siteUrl: jiraConnection.status.siteUrl, key: created.key }, { force: true })
            .then((issue) => { if (issue) noteJiraIssueCreated(projectRoot, issue); })
            .catch(() => undefined);
          showToast({
            tone: "success",
            title: `Created ${created.key}`,
            message: trimmed,
            actions: [{
              label: "Start lane",
              onClick: () => {
                void loadJiraIssue(projectRoot, { provider: "jira", siteUrl, key: created.key })
                  .then((issue) => {
                    const launchIssue = issue ? buildJiraLaunchIssue(issue, siteUrl) : null;
                    if (!launchIssue) throw new Error(`Could not read ${created.key} from Jira.`);
                    requestIssueLaunch([launchIssue], { laneOnly: true });
                  })
                  .catch((error: unknown) => showToast({
                    tone: "error",
                    title: "Could not start a lane",
                    message: extractError(error),
                  }));
              },
            }],
          });
          captureIssueCreated("jira");
          if (!createMore && request.origin !== "pane") {
            openIssueRef({ ref: { provider: "jira", siteUrl: jiraConnection.status.siteUrl, key: created.key, url: created.url }, source: "issue-viewer" });
          }
        } else {
        const { issue, warnings } = await submitGitHubIssue({
          repo,
          title: trimmed,
          body,
          contextFooter,
          fields: github,
          template,
          templateRequired,
          formAnswers,
          attachments,
        });
        noteGitHubIssueCreated(projectRoot, issue);
        // A warning (not linked under the parent, fields not set) is worth reading.
        showToast({
          tone: warnings.length ? "warning" : "success",
          title: `Created #${issue.number}`,
          message: warnings.length ? warnings.join(" ") : issue.title,
          ...(warnings.length ? { durationMs: 18_000 } : {}),
          actions: [{ label: "Start lane", onClick: () => requestGitHubIssueLaunch(issue) }],
        });
        captureIssueCreated("github");
        announceIssueCreated({ provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number });
        if (!createMore && request.origin !== "pane") {
          openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" });
        }
        }
      }
      if (createMore) reset();
      else {
        draftRef.current = null;
        writeIssueDraft(provider, projectRoot, null);
        onClose();
      }
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : "The issue was not created.", kind: "failure" });
    } finally {
      setBusy(false);
    }
  };

  const project = linearTeamProjects(catalog, teamKey).find((entry) => entry.id === linear.projectId) ?? null;
  const linearTemplate = createOptions?.templates.find((entry) => entry.id === linear.templateId) ?? null;

  /* Template chip */
  const templateOptions: PickerOption[] = provider === "linear"
    ? [{ id: "", label: "No template" }, ...(createOptions?.templates ?? []).map((entry) => ({ id: entry.id, label: entry.name }))]
    : provider === "github" ? [
      ...(createCatalog.templates?.blankIssuesEnabled !== false ? [{ id: "", label: "Blank issue" }] : []),
      ...templates.map((entry) => ({ id: entry.key, label: entry.name, keywords: entry.about ?? "" })),
    ] : [];
  const templateLabel = provider === "linear" ? linearTemplate?.name ?? null : provider === "github" ? template?.name ?? null : null;
  const hasTemplates = provider === "linear" ? (createOptions?.templates.length ?? 0) > 0 : provider === "github" && templates.length > 0;

  const scopeLabel = provider === "linear" ? null : provider === "github" ? (repo ? `${repo.owner}/${repo.name}` : "No GitHub repository") : jira.projectKey || jiraConnection.status?.siteUrl || "Jira";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="New issue"
      hideHeader
      size="lg"
      bodyPadding={false}
      scrollBody={false}
      preventAutoFocus
      testId="issue-create"
    >
      <div
        className="flex max-h-[min(720px,calc(100vh_/_var(--ade-web-zoom-factor,1)_-_64px))] flex-col"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (isMacRuntimeTarget() ? event.metaKey : event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <header className="kit-card-head border-b border-[color:var(--kit-rule)]">
          {parent ? (
            provider === "linear" ? <LinearMark size={14} /> : provider === "github" ? <GithubLogo size={14} weight="fill" /> : <JiraMark size={14} />
          ) : (
            <div className="kit-seg" data-case="sentence" role="group" aria-label="Tracker">
              <button type="button" className="inline-flex items-center gap-1" aria-pressed={provider === "linear"} onClick={() => setProvider("linear")}>
                <LinearMark size={11} /> Linear
              </button>
              <button type="button" className="inline-flex items-center gap-1" aria-pressed={provider === "github"} onClick={() => setProvider("github")}>
                <GithubLogo size={11} weight="fill" /> GitHub
              </button>
              <button type="button" className="inline-flex items-center gap-1" aria-pressed={provider === "jira"} onClick={() => setProvider("jira")}>
                <JiraMark size={11} /> Jira
              </button>
            </div>
          )}
          {provider === "linear" ? (
            <ChipPicker
              label="Team"
              display={teamKey ?? "Team"}
              options={teams.map((team) => ({ id: team.key, label: `${team.key} · ${team.name}` }))}
              selected={teamKey ? [teamKey] : []}
              placeholder="Team…"
              onPick={(id) => setLinear((current) => ({ ...current, teamKey: id, stateId: null, labelIds: [], projectId: null, milestoneId: null, cycleId: null, templateId: null }))}
            />
          ) : (
            <span className="truncate text-[12px] text-[color:var(--kit-text-2)]">{scopeLabel}</span>
          )}
          <span className="text-[color:var(--kit-text-3)]">›</span>
          <span className="text-[12px]">{parent ? `New sub-issue of ${parent.provider === "linear" ? parent.identifier : parent.provider === "jira" ? parent.key : `#${parent.number}`}` : "New issue"}</span>
          <span className="ml-auto flex items-center gap-1">
            {hasTemplates ? (
              <ChipPicker
                label="Template"
                display={templateLabel ?? (templateRequired ? "Pick a template" : "Template")}
                muted={!templateLabel}
                options={templateOptions}
                selected={[provider === "linear" ? linear.templateId ?? "" : provider === "github" ? github.templateKey ?? "" : ""]}
                placeholder="Template…"
                onPick={(id) => {
                  if (provider === "linear") applyLinearTemplate(id || null);
                  else if (provider === "github") applyGitHubTemplate(templates.find((entry) => entry.key === id) ?? null);
                }}
              />
            ) : null}
            <button type="button" className="kit-icon-btn" aria-label="Close" title="Close (Esc). The draft is kept." onClick={onClose}>
              <X size={13} />
            </button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
          {provider === "jira" && !jiraConnection.loading && !jiraConnection.status?.connected ? (
            <div className="mb-3">
              <Banner layout="inline" model={{
                id: "jira-create-not-connected",
                tone: "warning",
                title: "Jira is not connected",
                detail: jiraConnection.status?.error?.message ?? "Connect Jira on this machine before creating issues.",
                actions: [
                  { label: "Jira settings", onClick: () => { window.location.hash = `#${settingsRouteFor("integrations.jira")}`; } },
                  { label: "Retry", onClick: () => { void jiraConnection.refresh(); } },
                ],
              }} />
            </div>
          ) : null}
          {provider === "jira" && jiraBindingError ? (
            <div className="mb-3"><Banner layout="inline" model={{
              id: "jira-create-project-binding-error",
              tone: "warning",
              title: "Couldn't load this project's Jira bindings",
              detail: jiraBindingError,
              actions: [{ label: "Retry", onClick: () => {
                if (!jiraProjectTouched.current) jiraProjectDefaulted.current = false;
                setJiraBindingRetry((value) => value + 1);
              } }],
            }} /></div>
          ) : null}
          {provider === "jira" && jiraProjects.error ? (
            <div className="mb-3"><Banner layout="inline" model={{
              id: "jira-create-projects-error",
              tone: "warning",
              title: "Couldn't load Jira projects",
              detail: jiraProjects.error,
              actions: [{ label: "Retry", onClick: refreshJiraProjects }],
            }} /></div>
          ) : null}
          {provider === "jira" && jiraMetaError ? (
            <div className="mb-3"><Banner layout="inline" model={{
              id: "jira-create-meta-error",
              tone: "warning",
              title: `Couldn't load ${jira.projectKey} issue types`,
              detail: jiraMetaError,
              actions: [{ label: "Retry", onClick: () => {
                void loadJiraCreateMeta(projectRoot, jira.projectKey, true).then(setJiraMeta).catch((cause: unknown) => setJiraMetaError(cause instanceof Error ? cause.message : "Couldn't load Jira issue types."));
              } }],
            }} /></div>
          ) : null}
          {provider === "jira" && jiraCatalogError ? (
            <div className="mb-3"><Banner layout="inline" model={{
              id: "jira-create-fields-error",
              tone: "warning",
              title: "Couldn't load Jira assignees or labels",
              detail: jiraCatalogError,
              actions: [{ label: "Retry", onClick: () => {
                if (!jira.projectKey) return;
                setJiraCatalogError(null);
                void Promise.all([
                  loadJiraAssignableUsers(projectRoot, { projectKey: jira.projectKey }),
                  loadJiraLabels(projectRoot),
                ]).then(([users, nextLabels]) => { setJiraUsers(users); setJiraLabels(nextLabels); }).catch((cause: unknown) => setJiraCatalogError(cause instanceof Error ? cause.message : "Couldn't load Jira fields."));
              } }],
            }} /></div>
          ) : null}
          <input
            ref={titleRef}
            autoFocus
            aria-label="Issue title"
            placeholder="Issue title"
            className="w-full bg-transparent text-[19px] font-semibold tracking-[-0.01em] text-fg outline-none placeholder:text-[color:var(--kit-text-3)] focus:!shadow-none"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {similar.length ? (
            <div className="mt-2 flex flex-col gap-0.5 rounded-md border border-[color:var(--kit-panel-edge)] bg-[color:var(--kit-panel-bg)] px-2 py-1.5">
              <div className="kit-eyebrow">Similar open issues</div>
              {similar.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-[color:var(--kit-hover)]"
                  title="Open it. Your draft is kept."
                  onClick={() => {
                    entry.open();
                    onClose();
                  }}
                >
                  {entry.icon}
                  <span className="kit-num shrink-0 text-[11px] text-[color:var(--kit-text-2)]">{entry.label}</span>
                  <span className="truncate text-fg/85">{entry.title}</span>
                </button>
              ))}
            </div>
          ) : null}

          {formTemplate ? (
            <GitHubIssueFormFields template={formTemplate} answers={formAnswers} onChange={setFormAnswers} />
          ) : (
            <div
              className="relative mt-3"
              onDragOver={(event) => {
                if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => {
                const files = imageFiles(event.dataTransfer.files);
                if (!files.length) return;
                event.preventDefault();
                void addPictures(files);
              }}
            >
              <textarea
                ref={bodyRef}
                aria-label="Issue description"
                placeholder={provider === "jira" ? "Add a description… (Markdown)" : "Add a description… (Markdown; paste or drop pictures)"}
                className="min-h-[160px] w-full resize-y bg-transparent text-[13px] leading-relaxed text-fg/90 outline-none placeholder:text-[color:var(--kit-text-3)] focus:!shadow-none"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onPaste={(event) => {
                  const files = imageFiles(event.clipboardData.files);
                  if (!files.length) return;
                  event.preventDefault();
                  void addPictures(files);
                }}
              />
            </div>
          )}

          {provider === "github" && attachments.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {attachments.map((attachment, index) => (
                <span key={`${attachment.filename}-${index}`} className="inline-flex h-6 items-center gap-1 rounded-md border border-fg/[0.08] px-1.5 text-[11px] text-fg/80">
                  <ImageIcon size={11} />
                  <span className="max-w-[160px] truncate">{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    className="text-[color:var(--kit-text-3)] hover:text-fg"
                    onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={9} weight="bold" />
                  </button>
                </span>
              ))}
              <span className="text-[11px] text-[color:var(--kit-text-3)]">Uploaded with the issue through GitHub CLI.</span>
            </div>
          ) : null}
          {uploads > 0 ? (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[color:var(--kit-text-3)]">
              <CircleNotch size={11} className="animate-spin" /> Uploading {uploads === 1 ? "a picture" : `${uploads} pictures`}…
            </div>
          ) : null}
          {contextFooter ? (
            <p className="mt-2 text-[11px] text-[color:var(--kit-text-3)]">A “Context” footer links this issue back to the chat.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-[color:var(--kit-rule)] px-4 py-2.5">
          {provider === "linear"
            ? <LinearCreateChips linear={linear} setLinear={setLinear} catalog={catalog} teamKey={teamKey} />
            : provider === "github"
              ? <GitHubCreateChips github={github} setGitHub={setGitHub} repoCatalog={repoCatalog} types={createCatalog.types} />
              : <JiraCreateChips jira={jira} setJira={setJira} projects={jiraProjects.projects} meta={jiraMeta} users={jiraUsers} labels={jiraLabels} onProjectPick={() => { jiraProjectTouched.current = true; jiraProjectDefaulted.current = true; }} />}
          <button
            type="button"
            className="kit-icon-btn"
            aria-label={showMore ? "Fewer fields" : "More fields"}
            title={showMore ? "Fewer fields" : "More fields"}
            aria-pressed={showMore}
            onClick={() => setShowMore((value) => !value)}
          >
            <DotsThree size={14} weight="bold" />
          </button>
          {showMore ? (
            <div className="flex w-full flex-wrap items-center gap-1.5">
              {provider === "linear" ? (
                <LinearMoreFields
                  linear={linear}
                  setLinear={setLinear}
                  hasProject={project != null}
                  milestones={milestones}
                  createOptions={createOptions}
                  parentLocked={parent?.provider === "linear"}
                />
              ) : provider === "github" ? (
                <GitHubMoreFields github={github} setGitHub={setGitHub} parentLocked={parent?.provider === "github"} />
              ) : (
                <JiraMoreFields jira={jira} setJira={setJira} parentLocked={Boolean(jiraParent)} />
              )}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-[color:var(--kit-rule)] px-4 py-2.5">
          <label className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--kit-text-2)]">
            <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} />
            Create more
          </label>
          {error ? (
            <Banner
              layout="inline"
              style={{ flex: 1, minWidth: 0 }}
              model={{
                id: "issue-create-error",
                ...noticeKindModel(error.kind, error.kind === "failure" ? { surface: "issue_create" } : undefined),
                title: error.message,
                dismiss: { onDismiss: () => setError(null) },
              }}
            />
          ) : <span className="flex-1" />}
          <span className="text-[11px] text-[color:var(--kit-text-3)]">{MOD()}↵</span>
          <button
            type="button"
            className="kit-btn kit-btn-primary"
            disabled={busy || uploads > 0 || (provider === "github" && !repo) || (provider === "jira" && (!jiraConnection.status?.connected || !jira.projectKey || !jira.issueTypeId))}
            onClick={() => void submit()}
          >
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            Create issue
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
