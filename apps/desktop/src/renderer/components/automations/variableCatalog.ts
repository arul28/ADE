/**
 * Template variables available to a rule's steps, grouped by trigger source.
 * Any text input that accepts `{{trigger.*}}` placeholders offers these through
 * the variable menu. Stored raw; resolution happens server-side.
 */

import { sourceForTriggerType, type TriggerSource } from "./triggerCatalog";

export type TemplateVariable = {
  /** The raw token inserted at the cursor, e.g. "{{trigger.issue.title}}". */
  token: string;
  /** Short human label for the menu. */
  label: string;
};

export type VariableGroup = {
  title: string;
  variables: TemplateVariable[];
};

const ISSUE_VARS: TemplateVariable[] = [
  { token: "{{trigger.issue.number}}", label: "Issue number" },
  { token: "{{trigger.issue.title}}", label: "Issue title" },
  { token: "{{trigger.issue.author}}", label: "Issue author" },
  { token: "{{trigger.issue.labels}}", label: "Issue labels" },
  { token: "{{trigger.issue.url}}", label: "Issue URL" },
  { token: "{{trigger.issue.body}}", label: "Issue body" },
];

const PR_VARS: TemplateVariable[] = [
  { token: "{{trigger.pr.number}}", label: "PR number" },
  { token: "{{trigger.pr.title}}", label: "PR title" },
  { token: "{{trigger.pr.author}}", label: "PR author" },
  { token: "{{trigger.pr.url}}", label: "PR URL" },
  { token: "{{trigger.branch}}", label: "Branch" },
];

const LINEAR_VARS: TemplateVariable[] = [
  { token: "{{trigger.issue.title}}", label: "Issue title" },
  { token: "{{trigger.issue.team}}", label: "Team" },
  { token: "{{trigger.issue.project}}", label: "Project" },
  { token: "{{trigger.issue.assignee}}", label: "Assignee" },
  { token: "{{trigger.issue.state}}", label: "State" },
  { token: "{{trigger.issue.labels}}", label: "Labels" },
];

const LANE_VARS: TemplateVariable[] = [
  { token: "{{trigger.lane.id}}", label: "Lane id" },
  { token: "{{trigger.laneName}}", label: "Lane name" },
  { token: "{{trigger.branch}}", label: "Branch" },
];

const DATE_VARS: TemplateVariable[] = [
  { token: "{{date}}", label: "Date (today)" },
  { token: "{{time}}", label: "Time (now)" },
];

/** Which variable groups apply to a given trigger type. */
export function variablesForTrigger(triggerType: string): VariableGroup[] {
  const source: TriggerSource = sourceForTriggerType(triggerType);
  const groups: VariableGroup[] = [];

  if (source === "github") {
    if (triggerType.includes("issue")) groups.push({ title: "Issue", variables: ISSUE_VARS });
    if (triggerType.includes("pr")) groups.push({ title: "Pull request", variables: PR_VARS });
  } else if (source === "linear") {
    groups.push({ title: "Linear issue", variables: LINEAR_VARS });
  } else if (source === "lane" || source === "git") {
    groups.push({ title: "Lane", variables: LANE_VARS });
  }

  groups.push({ title: "Date & time", variables: DATE_VARS });
  return groups;
}
