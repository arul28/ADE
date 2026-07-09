/**
 * Icons live apart from the template definitions so `templateData.ts` stays a
 * pure data module — the main-process template validation test imports it and
 * must not pull React icon components into a node test environment.
 */

import {
  Broom,
  Bug,
  ChatCircleText,
  ClockCounterClockwise,
  GitPullRequest,
  Lightning,
  Sparkle,
  Tag,
  TestTube,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";

const TEMPLATE_ICONS: Record<string, ElementType> = {
  "daily-agent-task": Sparkle,
  "linear-issue-lane-agent": Lightning,
  "github-issue-lane-agent": GitPullRequest,
  "clean-up-merged-lanes": Broom,
  "pr-review-session": GitPullRequest,
  "pr-comment-responder": ChatCircleText,
  "daily-agent-brief": ChatCircleText,
  "issue-triage": Warning,
  "auto-label-issue": Tag,
  "linear-label-triage": Tag,
  "stale-issue-closer": ClockCounterClockwise,
  "push-conflict-scan": Bug,
  "label-welcome": ChatCircleText,
  "nightly-test-sweep": TestTube,
};

export function templateIconFor(templateId: string): ElementType {
  return TEMPLATE_ICONS[templateId] ?? Sparkle;
}
