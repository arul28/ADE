import type { GitHubIssueAttachmentInput, NormalizedLinearIssue } from "../../../shared/types";
import type { JiraCreateMeta, JiraCreateIssueResult } from "../../../shared/types/jira";
import {
  missingRequiredGitHubFormField,
  serializeGitHubIssueForm,
  type GitHubIssueFormAnswers,
  type GitHubIssueTemplate,
} from "../../../shared/githubIssueTemplates";
import { normalizeGitHubIssue, type GitHubIssueDetail, type GitHubRepo } from "./githubIssueStore";
import type { GitHubFields, JiraFields, LinearFields } from "./issueCreateDraft";

/**
 * Sending a new issue to its tracker. Each function checks what the form
 * cannot know until submit (a team, a parent that exists, a required template
 * field), creates the issue, and returns it; the dialog owns the toast and
 * where the issue opens.
 */

export async function submitLinearIssue(input: {
  teamKey: string | null;
  title: string;
  description: string;
  fields: LinearFields;
}): Promise<NormalizedLinearIssue> {
  const { fields } = input;
  if (!input.teamKey) throw new Error("Pick a team.");
  const create = window.ade?.cto?.createLinearIssue;
  if (!create) throw new Error("Creating Linear issues is not available here.");
  let parentId: string | null = null;
  const parent = fields.parent.trim();
  if (parent) {
    const parentIssue = await window.ade?.cto?.getLinearIssue?.({ issueId: parent });
    if (!parentIssue) throw new Error(`Linear didn't return the parent ${parent}.`);
    parentId = parentIssue.id;
  }
  return await create({
    teamKey: input.teamKey,
    title: input.title,
    description: input.description,
    stateId: fields.stateId,
    priority: fields.priority,
    assigneeId: fields.assigneeId,
    labelIds: fields.labelIds,
    projectId: fields.projectId,
    projectMilestoneId: fields.projectId ? fields.milestoneId : null,
    cycleId: fields.cycleId,
    estimate: fields.estimate,
    dueDate: fields.dueDate || null,
    parentId,
    templateId: fields.templateId,
  });
}

export async function submitGitHubIssue(input: {
  repo: GitHubRepo | null;
  title: string;
  body: string;
  contextFooter: string;
  fields: GitHubFields;
  template: GitHubIssueTemplate | null;
  templateRequired: boolean;
  formAnswers: GitHubIssueFormAnswers;
  attachments: GitHubIssueAttachmentInput[];
}): Promise<{ issue: GitHubIssueDetail; warnings: string[] }> {
  const { repo, fields, template } = input;
  if (!repo) throw new Error("This project has no GitHub repository.");
  if (input.templateRequired && !template) throw new Error("This repository asks for a template. Pick one.");
  const formTemplate = template?.kind === "form" ? template : null;
  if (formTemplate) {
    const missing = missingRequiredGitHubFormField(formTemplate, input.formAnswers);
    if (missing) throw new Error(`Fill in "${missing}".`);
  }
  const create = window.ade?.github?.createIssue;
  if (!create) throw new Error("Creating GitHub issues is not available here.");
  const description = formTemplate ? serializeGitHubIssueForm(formTemplate, input.formAnswers) : input.body;
  const parentNumber = Number(fields.parent.replace(/^#/, ""));
  const result = await create({
    owner: repo.owner,
    name: repo.name,
    input: {
      title: input.title,
      body: `${description}${input.contextFooter}`,
      labels: fields.labels,
      assignees: fields.assignees,
      milestone: fields.milestone,
      type: fields.type,
      parentNumber: Number.isInteger(parentNumber) && parentNumber > 0 ? parentNumber : null,
      attachments: input.attachments,
    },
  });
  const issue = normalizeGitHubIssue(repo.owner, repo.name, result.issue);
  if (!issue) throw new Error("GitHub created the issue but did not return it.");
  return { issue, warnings: result.warnings };
}

export async function submitJiraIssue(input: {
  title: string;
  description: string;
  fields: JiraFields;
  meta: JiraCreateMeta | null;
}): Promise<JiraCreateIssueResult> {
  const { fields } = input;
  if (!fields.projectKey) throw new Error("Pick a Jira project.");
  if (!fields.issueTypeId) throw new Error("Pick a Jira issue type.");
  const issueType = input.meta?.issueTypes.find((entry) => entry.id === fields.issueTypeId);
  if (!issueType) throw new Error("Reload the Jira issue types and choose one that is available.");
  const unsupportedRequired = issueType.fields.filter((field) => field.required && !field.supported);
  if (unsupportedRequired.length) {
    throw new Error(`Jira requires fields ADE cannot fill: ${unsupportedRequired.map((field) => field.name).join(", ")}. Choose another issue type.`);
  }
  const create = window.ade?.jira?.createIssue;
  if (!create) throw new Error("Creating Jira issues is not available here.");
  return create({
    projectKey: fields.projectKey,
    issueTypeId: fields.issueTypeId,
    title: input.title,
    description: input.description,
    labels: fields.labels,
    assigneeAccountId: fields.assigneeAccountId,
    priorityId: fields.priorityId,
    parentKey: fields.parentKey.trim().toUpperCase() || null,
    dueDate: fields.dueDate || null,
  });
}
