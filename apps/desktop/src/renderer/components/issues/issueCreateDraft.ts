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

export type IssueProvider = "linear" | "github";

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
  /** Answers to the GitHub issue form `github.templateKey` names. */
  formAnswers?: GitHubIssueFormAnswers;
};

export const EMPTY_LINEAR: LinearFields = {
  teamKey: null, stateId: null, priority: null, assigneeId: null, labelIds: [], projectId: null,
  milestoneId: null, cycleId: null, estimate: null, dueDate: "", parent: "", templateId: null,
};
export const EMPTY_GITHUB: GitHubFields = { labels: [], assignees: [], milestone: null, type: null, parent: "", templateKey: null };

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
      formAnswers: parsed.formAnswers && typeof parsed.formAnswers === "object" ? parsed.formAnswers : {},
    };
  } catch {
    return null;
  }
}

export function writeIssueDraft(provider: IssueProvider, scope: string | null, draft: IssueDraft | null): void {
  try {
    const answered = Object.values(draft?.formAnswers ?? {}).some((answer) =>
      Array.isArray(answer) ? answer.some(Boolean) : String(answer ?? "").trim().length > 0);
    if (!draft || (!draft.title.trim() && !draft.body.trim() && !answered)) {
      window.localStorage.removeItem(draftKey(provider, scope));
      return;
    }
    const kept: IssueDraft = {
      ...draft,
      linear: { ...draft.linear, parent: "" },
      github: { ...draft.github, parent: "" },
    };
    window.localStorage.setItem(draftKey(provider, scope), JSON.stringify(kept));
  } catch {
    // The draft is a convenience; losing it is not an error.
  }
}

export function initialIssueProvider(request: IssueCreateRequest): IssueProvider {
  if (request.prefill?.parent) return request.prefill.parent.provider;
  if (request.provider) return request.provider;
  try {
    const last = window.localStorage.getItem(LAST_PROVIDER_KEY);
    if (last === "linear" || last === "github") return last;
  } catch {
    // fall through
  }
  return "linear";
}

export function rememberIssueProvider(provider: IssueProvider): void {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch {
    // ignore
  }
}

/**
 * The form a request opens with. A request with text (a chat selection) starts
 * clean; otherwise the draft for the tracker and project comes back. A
 * sub-issue request fixes the parent, and for Linear the parent's team.
 */
export function initialIssueForm(request: IssueCreateRequest, scope: string | null): {
  provider: IssueProvider;
  title: string;
  body: string;
  linear: LinearFields;
  github: GitHubFields;
  formAnswers: GitHubIssueFormAnswers;
} {
  const provider = initialIssueProvider(request);
  const hasPrefill = Boolean(request.prefill?.title || request.prefill?.body);
  const draft = hasPrefill ? null : readIssueDraft(provider, scope);
  const linear = { ...EMPTY_LINEAR, ...(hasPrefill ? {} : readIssueDraft("linear", scope)?.linear ?? {}) };
  const githubDraft = hasPrefill ? null : readIssueDraft("github", scope);
  const github = { ...EMPTY_GITHUB, ...(githubDraft?.github ?? {}) };
  const parent = request.prefill?.parent ?? null;
  return {
    provider,
    title: request.prefill?.title ?? draft?.title ?? "",
    body: request.prefill?.body ?? draft?.body ?? "",
    linear: parent?.provider === "linear" ? { ...linear, parent: parent.identifier, teamKey: parent.teamKey ?? linear.teamKey } : linear,
    github: parent?.provider === "github" ? { ...github, parent: String(parent.number) } : github,
    formAnswers: githubDraft?.formAnswers ?? {},
  };
}
