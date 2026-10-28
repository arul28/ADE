/**
 * Icons live apart from the template definitions so `templateData.ts` stays a
 * pure data module — the main-process template validation test imports it and
 * must not pull React icon components into a node test environment.
 */

import {
  ArrowsLeftRight,
  Broom,
  Bug,
  ChatCircleText,
  GitPullRequest,
  Lightning,
  Sparkle,
  Tag,
  Wrench,
} from "@phosphor-icons/react";
import type { ElementType } from "react";

const TEMPLATE_ICONS: Record<string, ElementType> = {
  "daily-agent-task": Sparkle,
  "linear-issue-lane-agent": Lightning,
  "github-issue-lane-agent": GitPullRequest,
  "clean-up-merged-lanes": Broom,
  "pr-comment-responder": ChatCircleText,
  "auto-label-issue": Tag,
  "push-conflict-scan": Bug,
  "fix-failing-ci": Wrench,
  "fix-review-comments": ChatCircleText,
  "handoff-on-usage-limit": ArrowsLeftRight,
  "finished-chat-draft-pr": GitPullRequest,
};

export function templateIconFor(templateId: string): ElementType {
  return TEMPLATE_ICONS[templateId] ?? Sparkle;
}
