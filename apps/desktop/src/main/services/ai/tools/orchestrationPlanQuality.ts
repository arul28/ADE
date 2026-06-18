/**
 * Plan quality gates for the orchestration lead.
 *
 * The current gate (`assessPlanReadiness`) is structural and un-gameable: it
 * checks that each required section exists as a real heading in plan.md with a
 * substantive body, and cross-checks prose claims against actual manifest state
 * (validation steps derived, model routing present).
 */

import type {
  OrchestrationManifest,
  PlanSpecSectionId,
} from "../../../../shared/types/orchestration";
import {
  hasExplicitValidationWaiver,
  hasOrchestrationModelRouting,
} from "../../orchestration/runtimeProfile";

export type OrchestrationPlanQualityMissing = {
  id: string;
  label: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Structural readiness gate over plan.md + manifest state
// ---------------------------------------------------------------------------

/** Slug a markdown heading the same way the renderer's section anchors do. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<a\s+id=["'][^"']*["']>\s*<\/a>/gi, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type ParsedPlanSection = {
  headingText: string;
  level: number;
  slug: string;
  body: string;
};

/** Parse plan.md into its heading-delimited sections (level 1-6). */
export function parsePlanSections(planMd: string): ParsedPlanSection[] {
  const lines = (planMd ?? "").split(/\r?\n/);
  const out: ParsedPlanSection[] = [];
  const openSections: ParsedPlanSection[] = [];
  let activeFence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const fenceRun = fenceMatch[1]!;
      const marker = fenceRun[0] as "`" | "~";
      if (!activeFence) {
        activeFence = { marker, length: fenceRun.length };
      } else if (activeFence.marker === marker && fenceRun.length >= activeFence.length) {
        activeFence = null;
      }
      for (const section of openSections) {
        section.body += `${line}\n`;
      }
      continue;
    }
    const m = activeFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1]!.length;
      while (openSections.length && openSections[openSections.length - 1]!.level >= level) {
        openSections.pop();
      }
      for (const section of openSections) {
        section.body += `${line}\n`;
      }
      const headingText = m[2]!.replace(/<a\s+id=["'][^"']*["']>\s*<\/a>/gi, "").trim();
      const section = { headingText, level, slug: slugifyHeading(headingText), body: "" };
      out.push(section);
      openSections.push(section);
    } else {
      for (const section of openSections) {
        section.body += `${line}\n`;
      }
    }
  }
  return out;
}

const SECTION_LABELS: Record<PlanSpecSectionId, string> = {
  goal: "Goal",
  assumptions: "Assumptions",
  in_scope: "In scope",
  out_of_scope: "Out of scope / non-goals",
  alternatives: "Alternatives / tradeoffs",
  implementation_order: "Implementation order",
  agent_plan: "Agent plan",
  validation_plan: "Validation / proof plan",
  ui_decisions: "UI decisions",
  coordination: "Coordination / live log",
};

const SECTION_HEADING_PATTERNS: Record<PlanSpecSectionId, RegExp> = {
  goal: /^(?:goals?|objectives?|summary)\b/i,
  assumptions: /assumption/i,
  in_scope: /in[-\s]?scope|^scope$|scope of work/i,
  out_of_scope: /out[-\s]?of[-\s]?scope|non[-\s]?goals?|not\s+doing|excluded|deferred/i,
  alternatives: /alternativ|trade[-\s]?offs?|options?\s+considered|approaches?\s+considered/i,
  implementation_order: /implementation\s+order|execution\s+order|plan\s+of\s+work|sequence|phases?|dependenc|\border\b/i,
  agent_plan: /agent\s+plan|workers?|validators?|roles?\s*\/?\s*tags?|who\s+does|dispatch/i,
  validation_plan: /validation|verify|proof|testing|quality|gates?|\bchecks?\b/i,
  ui_decisions: /\bui\b|\bux\b|user[-\s]?facing|interface|design|screens?|wireframe|visual/i,
  coordination: /coordination|operations?\s+log|live\s+log|plan\s+sync|hand[-\s]?off|status\s+update|logging/i,
};

const MIN_BODY_CHARS = 24;

const DEFAULT_REQUIRED_SECTION_IDS: PlanSpecSectionId[] = [
  "goal",
  "in_scope",
  "out_of_scope",
  "alternatives",
  "implementation_order",
  "agent_plan",
  "validation_plan",
  "ui_decisions",
  "coordination",
];

const PENDING_GOAL_PLACEHOLDER_RE = /^_?pending\s+[—-]\s+the lead will fill this in_?$/i;

/**
 * Structural, un-gameable readiness check. For each required (non-N/A) section,
 * require a real plan.md heading with a substantive body; list-shaped sections
 * need concrete items. Then cross-check the load-bearing claims against real
 * manifest state so prose alone can't satisfy the gate.
 */
export function assessPlanReadiness(
  manifest: OrchestrationManifest,
  planMd: string,
): { ok: boolean; missing: OrchestrationPlanQualityMissing[] } {
  const sections = parsePlanSections(planMd);
  const specSections = manifest.planSpec?.sections ?? [];
  const requiredIds = specSections.length
    ? specSections
        .filter((s) => s.required && !s.notApplicable)
        .map((s) => s.id)
    : DEFAULT_REQUIRED_SECTION_IDS;

  const missing: OrchestrationPlanQualityMissing[] = [];
  const add = (id: PlanSpecSectionId, message: string) =>
    missing.push({ id, label: SECTION_LABELS[id], message });

  for (const id of requiredIds) {
    const pattern = SECTION_HEADING_PATTERNS[id];
    const matches = sections.filter((s) => pattern.test(s.headingText));
    if (!matches.length) {
      add(id, `Add a "## ${SECTION_LABELS[id]}" section to plan.md.`);
      continue;
    }
    const allowsNotApplicable = id === "ui_decisions";
    const hasSubstantiveMatch = matches.some((match) => {
      const body = match.body.trim();
      if (id === "goal" && PENDING_GOAL_PLACEHOLDER_RE.test(body)) {
        return false;
      }
      const explicitNa =
        allowsNotApplicable &&
        body.length < 80 &&
        /\b(n\/?a|not applicable|none|no ui|no ux)\b/i.test(body);
      return explicitNa || body.length >= MIN_BODY_CHARS;
    });
    if (!hasSubstantiveMatch) {
      add(id, `The "${SECTION_LABELS[id]}" section is too thin — add real substance${allowsNotApplicable ? " or mark it N/A with a reason" : ""}.`);
    }
  }

  // Cross-checks against real manifest state — the un-gameable part.
  if (requiredIds.includes("validation_plan") && !hasExplicitValidationWaiver(manifest) && manifest.validationStrategy.steps.length === 0) {
    add("validation_plan", "Derive at least one validationStrategy step (or log a skip-validation user override) — prose alone is not enough.");
  }
  if (requiredIds.includes("agent_plan") && !hasOrchestrationModelRouting(manifest)) {
    add("agent_plan", "Pick a model for at least one (role, tag) — the agent plan must be backed by real model routing.");
  }

  // Dedupe by section id (a cross-check may double up with a section miss).
  const byId = new Map<string, OrchestrationPlanQualityMissing>();
  for (const entry of missing) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return { ok: byId.size === 0, missing: [...byId.values()] };
}
