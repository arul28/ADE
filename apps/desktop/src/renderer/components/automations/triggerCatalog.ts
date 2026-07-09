/**
 * The trigger catalog drives the trigger picker: a user picks a SOURCE first,
 * then an EVENT, then filters. Kept as plain data so the picker, the rule
 * sentence, and the variable menu all read from one place.
 */

import {
  Calendar,
  ChatCircleText,
  CursorClick,
  FileText,
  GitBranch,
  GithubLogo,
  Tag,
  TreeStructure,
  WebhooksLogo,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type { AutomationTrigger } from "../../../shared/types";
import { LANE_MERGED_TRIGGER_TYPE } from "./localAutomationConfig";

export type TriggerSource =
  | "schedule"
  | "github"
  | "linear"
  | "lane"
  | "git"
  | "file"
  | "session"
  | "webhook"
  | "manual";

export type TriggerEvent = {
  value: string;
  label: string;
};

export type TriggerSourceDef = {
  value: TriggerSource;
  label: string;
  icon: ElementType;
  /** One-line description used in the source picker. */
  hint: string;
  events: TriggerEvent[];
};

export const TRIGGER_SOURCES: readonly TriggerSourceDef[] = [
  {
    value: "schedule",
    label: "Schedule",
    icon: Calendar,
    hint: "Run on a clock",
    events: [{ value: "schedule", label: "On a schedule" }],
  },
  {
    value: "github",
    label: "GitHub",
    icon: GithubLogo,
    hint: "Pull requests, issues, comments",
    events: [
      { value: "github.pr_opened", label: "PR opened" },
      { value: "github.pr_updated", label: "PR updated" },
      { value: "github.pr_merged", label: "PR merged" },
      { value: "github.pr_closed", label: "PR closed" },
      { value: "github.pr_commented", label: "PR commented on" },
      { value: "github.pr_review_submitted", label: "PR review submitted" },
      { value: "github.issue_opened", label: "Issue opened" },
      { value: "github.issue_edited", label: "Issue edited" },
      { value: "github.issue_closed", label: "Issue closed" },
      { value: "github.issue_labeled", label: "Issue labeled" },
      { value: "github.issue_commented", label: "Issue commented on" },
    ],
  },
  {
    value: "linear",
    label: "Linear",
    icon: Tag,
    hint: "Issues, status, labels",
    events: [
      { value: "linear.issue_created", label: "Issue created" },
      { value: "linear.issue_updated", label: "Issue updated" },
      { value: "linear.issue_assigned", label: "Issue assigned" },
      { value: "linear.issue_status_changed", label: "Status changed" },
      { value: "linear.issue_labeled", label: "Issue labeled" },
    ],
  },
  {
    value: "lane",
    label: "Lanes",
    icon: TreeStructure,
    hint: "Lane lifecycle",
    events: [
      { value: "lane.created", label: "Lane created" },
      { value: "lane.archived", label: "Lane archived" },
      { value: LANE_MERGED_TRIGGER_TYPE, label: "Lane merged" },
    ],
  },
  {
    value: "git",
    label: "Git",
    icon: GitBranch,
    hint: "Local commits and pushes",
    events: [
      { value: "git.commit", label: "Commit created" },
      { value: "git.push", label: "Push completed" },
    ],
  },
  {
    value: "file",
    label: "Files",
    icon: FileText,
    hint: "Watch paths in the repo",
    events: [{ value: "file.change", label: "File changed" }],
  },
  {
    value: "session",
    label: "Chat session",
    icon: ChatCircleText,
    hint: "When an agent session ends",
    events: [{ value: "session-end", label: "Session ended" }],
  },
  {
    value: "webhook",
    label: "Webhook",
    icon: WebhooksLogo,
    hint: "External events",
    events: [
      { value: "github-webhook", label: "GitHub webhook" },
      { value: "webhook", label: "Custom webhook" },
    ],
  },
  {
    value: "manual",
    label: "Manual",
    icon: CursorClick,
    hint: "Run on demand only",
    events: [{ value: "manual", label: "Run manually" }],
  },
];

export function sourceForTriggerType(type: string): TriggerSource {
  if (type === "schedule") return "schedule";
  if (type.startsWith("github.") || type.startsWith("git.pr_")) return "github";
  if (type === "git.commit" || type === "git.push") return "git";
  if (type.startsWith("linear.")) return "linear";
  if (type === "file.change") return "file";
  if (type === "lane.created" || type === "lane.archived" || type === LANE_MERGED_TRIGGER_TYPE) return "lane";
  if (type === "session-end") return "session";
  if (type === "github-webhook" || type === "webhook") return "webhook";
  return "manual";
}

export function sourceDef(source: TriggerSource): TriggerSourceDef {
  return TRIGGER_SOURCES.find((s) => s.value === source) ?? TRIGGER_SOURCES[TRIGGER_SOURCES.length - 1]!;
}

export function eventLabel(type: string): string {
  for (const source of TRIGGER_SOURCES) {
    const found = source.events.find((event) => event.value === type);
    if (found) return found.label;
  }
  return type;
}

/** A sensible default trigger when switching to a source. */
export function defaultTriggerForSource(source: TriggerSource): AutomationTrigger {
  switch (source) {
    case "schedule":
      return { type: "schedule", cron: "0 9 * * 1-5" };
    case "github":
      return { type: "github.issue_opened" };
    case "linear":
      return { type: "linear.issue_created" };
    case "lane":
      return { type: LANE_MERGED_TRIGGER_TYPE as AutomationTrigger["type"] };
    case "git":
      return { type: "git.push" };
    case "file":
      return { type: "file.change" };
    case "session":
      return { type: "session-end" };
    case "webhook":
      return { type: "github-webhook", event: "pull_request" };
    case "manual":
      return { type: "manual" };
  }
}
