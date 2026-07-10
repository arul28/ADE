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
  TreeStructure,
  WebhooksLogo,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type { AutomationTrigger } from "../../../shared/types";
import { LINEAR_BRAND, LinearMark } from "../lanes/linearBrand";
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
  value: AutomationTrigger["type"];
  label: string;
};

export type TriggerSourceDef = {
  value: TriggerSource;
  label: string;
  icon: ElementType;
  accent: string;
  /** One-line description used in the source picker. */
  hint: string;
  events: TriggerEvent[];
};

export const TRIGGER_SOURCES: readonly TriggerSourceDef[] = [
  {
    value: "schedule",
    label: "Schedule",
    icon: Calendar,
    accent: "#E8B45A",
    hint: "Run on a clock",
    events: [{ value: "schedule", label: "On a schedule" }],
  },
  {
    value: "github",
    label: "GitHub",
    icon: GithubLogo,
    accent: "#A8B1BB",
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
    icon: LinearMark,
    accent: LINEAR_BRAND.primary,
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
    accent: "#8B7CF6",
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
    accent: "#F05133",
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
    accent: "#45C4A0",
    hint: "Watch paths in the repo",
    events: [{ value: "file.change", label: "File changed" }],
  },
  {
    value: "session",
    label: "Chat session",
    icon: ChatCircleText,
    accent: "#58A6FF",
    hint: "When an agent session ends",
    events: [{ value: "session-end", label: "Session ended" }],
  },
  {
    value: "webhook",
    label: "Webhook",
    icon: WebhooksLogo,
    accent: "#EC6CB9",
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
    accent: "#9AA4B2",
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

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function sourceAccent(source: TriggerSource): string {
  return sourceDef(source).accent;
}

/** Return an rgba() tint derived from the source's hex accent. */
export function accentTint(source: TriggerSource, alpha: number): string {
  return hexToRgba(sourceAccent(source), alpha);
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
      return { type: LANE_MERGED_TRIGGER_TYPE };
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
