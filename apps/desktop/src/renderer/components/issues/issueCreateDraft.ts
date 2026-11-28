import type { GitHubIssueFormAnswers } from "../../../shared/githubIssueTemplates";
import type { IssueCreateRequest } from "../../lib/issueCreateRequests";

/**
 * The create composer's form state, and the draft kept while you type.
 *
 * A draft belongs to one tracker in one project: a label, milestone or team
 * picked for one repository means nothing in another. The parent issue is
 * never kept. It comes from "New sub-issue" and would otherwise make the next
 * plain "New" a sub-issue of an unrelated issue, behind a collapsed row.
 */

export type IssueProvider = "linear" | "github" | "jira";

export type JiraFields = {
  projectKey: string;
  issueTypeId: string;
  assigneeAccountId: string | null;
  priorityId: string | null;
  labels: string[];
  parentKey: string;
  dueDate: string;
};

export type LinearFields = {
  teamKey: string | null;
  stateId: string | null;
  priority: number | null;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string;
  parent: string;
  templateId: string | null;
};

export type GitHubFields = {
  labels: string[];
  assignees: string[];
  milestone: number | null;
  type: string | null;
  parent: string;
  templateKey: string | null;
};

export type IssueDraft = {
  title: string;
  body: string;
  linear: LinearFields;
  github: GitHubFields;
  jira?: JiraFields;
  /** Answers to the GitHub issue form `github.templateKey` names. */
  formAnswers?: GitHubIssueFormAnswers;
};

export const EMPTY_LINEAR: LinearFields = {
  teamKey: null, stateId: null, priority: null, assigneeId: null, labelIds: [], projectId: null,
  milestoneId: null, cycleId: null, estimate: null, dueDate: "", parent: "", templateId: null,
};
export const EMPTY_GITHUB: GitHubFields = { labels: [], assignees: [], milestone: null, type: null, parent: "", templateKey: null };
export const EMPTY_JIRA: JiraFields = { projectKey: "", issueTypeId: "", assigneeAccountId: null, priorityId: null, labels: [], parentKey: "", dueDate: "" };

const LAST_PROVIDER_KEY = "ade.issueCreate.lastProvider";
const draftKey = (provider: IssueProvider, scope: string | null) => `ade.issueCreate.draft.v2:${provider}:${scope ?? ""}`;

export function readIssueDraft(provider: IssueProvider, scope: string | null): IssueDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(provider, scope));
    const parsed = raw ? JSON.parse(raw) as Partial<IssueDraft> : null;
    if (!parsed) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      linear: { ...EMPTY_LINEAR, ...(parsed.linear ?? {}), parent: "" },
      github: { ...EMPTY_GITHUB, ...(parsed.github ?? {}), parent: "" },
      jira: { ...EMPTY_JIRA, ...(parsed.jira ?? {}), parentKey: "" },
      formAnswers: parsed.formAnswers && typeof parsed.formAnswers === "object" ? parsed.formAnswers : {},
    };
  } catch (error) {
    console.warn("[issues] could not read the saved draft", error);
    return null;
  }
}

export function writeIssueDraft(provider: IssueProvider, scope: string | null, draft: IssueDraft | null): void {
  try {
    const answered = Object.values(draft?.formAnswers ?? {}).some((answer) =>
      Array.isArray(answer) ? answer.some(Boolean) : String(answer ?? "").trim().length > 0);
    const hasFields = Boolean(draft && (
      draft.linear.teamKey || draft.linear.stateId || draft.linear.priority || draft.linear.assigneeId
      || draft.linear.labelIds.length || draft.linear.projectId || draft.linear.milestoneId
      || draft.linear.cycleId || draft.linear.estimate != null || draft.linear.dueDate || draft.linear.templateId
      || draft.github.labels.length || draft.github.assignees.length || draft.github.milestone != null
      || draft.github.type || draft.github.templateKey
      || draft.jira?.projectKey || draft.jira?.issueTypeId || draft.jira?.assigneeAccountId
      || draft.jira?.priorityId || draft.jira?.labels.length || draft.jira?.dueDate
    ));
    if (!draft || (!draft.title.trim() && !draft.body.trim() && !answered && !hasFields)) {
      window.localStorage.removeItem(draftKey(provider, scope));
      return;
    }
    const kept: IssueDraft = {
      ...draft,
      linear: { ...draft.linear, parent: "" },
      github: { ...draft.github, parent: "" },
      jira: { ...(draft.jira ?? EMPTY_JIRA), parentKey: "" },
    };
    window.localStorage.setItem(draftKey(provider, scope), JSON.stringify(kept));
  } catch (error) {
    // The draft is a convenience; losing it is not an error, but say so.
    console.warn("[issues] could not save the draft", error);
  }
}

export function initialIssueProvider(request: IssueCreateRequest): IssueProvider {
  if (request.prefill?.parent) {
    return request.prefill.parent.provider;
  }
  if (request.prefill?.linear) return "linear";
  if (request.provider === "linear" || request.provider === "github" || request.provider === "jira") return request.provider;
  try {
    const last = window.localStorage.getItem(LAST_PROVIDER_KEY);
    if (last === "linear" || last === "github" || last === "jira") return last;
  } catch (error) {
    console.warn("[issues] could not read the last tracker", error);
  }
  return "linear";
}

export function rememberIssueProvider(provider: IssueProvider): void {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch (error) {
    console.warn("[issues] could not remember the tracker", error);
  }
}

/**
 * The form a request opens with. A request with text (a chat selection) starts
 * clean; otherwise the draft for the tracker and project comes back. A
 * sub-issue request fixes the parent, and for Linear the parent's team.
 *
 * A request with Linear fields (a list group's "+") opens a separate, unsaved
 * form: it reads no draft and `keepsDraft` is false, so typing in it never
 * overwrites (and creating from it never clears) the saved draft.
 */
export function initialIssueForm(request: IssueCreateRequest, scope: string | null): {
  provider: IssueProvider;
  keepsDraft: boolean;
  title: string;
  body: string;
  linear: LinearFields;
  github: GitHubFields;
  jira: JiraFields;
  formAnswers: GitHubIssueFormAnswers;
} {
  const provider = initialIssueProvider(request);
  const linearPrefill = request.prefill?.linear ?? null;
  const keepsDraft = !linearPrefill;
  const hasPrefill = Boolean(request.prefill?.title || request.prefill?.body) || !keepsDraft;
  const draft = hasPrefill ? null : readIssueDraft(provider, scope);
  const linear = linearPrefill
    ? { ...EMPTY_LINEAR, ...linearPrefill, labelIds: linearPrefill.labelIds ?? [] }
    : { ...EMPTY_LINEAR, ...(hasPrefill ? {} : readIssueDraft("linear", scope)?.linear ?? {}) };
  const githubDraft = hasPrefill ? null : readIssueDraft("github", scope);
  const github = { ...EMPTY_GITHUB, ...(githubDraft?.github ?? {}) };
  const jira = { ...EMPTY_JIRA, ...(hasPrefill ? {} : readIssueDraft("jira", scope)?.jira ?? {}) };
  const parent = request.prefill?.parent ?? null;
  const jiraParent = parent?.provider === "jira" ? parent : null;
  return {
    provider,
    keepsDraft,
    title: request.prefill?.title ?? draft?.title ?? "",
    body: request.prefill?.body ?? draft?.body ?? "",
    linear: parent?.provider === "linear" ? { ...linear, parent: parent.identifier, teamKey: parent.teamKey ?? linear.teamKey } : linear,
    github: parent?.provider === "github" ? { ...github, parent: String(parent.number) } : github,
    jira: jiraParent ? { ...jira, parentKey: jiraParent.key } : jira,
    formAnswers: githubDraft?.formAnswers ?? {},
  };
}
