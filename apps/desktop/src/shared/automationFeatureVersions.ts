/**
 * Automation features a rule's machine must be new enough to run.
 *
 * A rule is saved to, and runs on, the machine it names, and that machine can
 * run an older ADE than the window editing it. Without this the builder offered
 * a step the machine's ADE does not have, and the first sign was a raw
 * `action_not_callable` after a click. Add a row when a step type, an ADE
 * action an automation can call, or a lane mode first ships, with the first
 * release that has it. Anything without a row is treated as available.
 */

import { compareUpdateVersions } from "./updateVersions";

export type AutomationFeatureRequirement = {
  /** What the user sees, e.g. "Send notification to mobile app". */
  label: string;
  /** The first release that has it. */
  minVersion: string;
};

/** ADE actions an automation step can call, by `domain.action`. */
const ACTION_MIN_VERSIONS: Record<string, AutomationFeatureRequirement> = {
  "attention.sendNotification": { label: "Send notification to mobile app", minVersion: "1.2.96" },
};

/** Lane modes ("Run in"). */
const LANE_MODE_MIN_VERSIONS: Record<string, AutomationFeatureRequirement> = {
  "pr-branch": { label: "Run in the PR's branch", minVersion: "1.2.95" },
};

type DraftLike = {
  execution?: {
    laneMode?: string | null;
    builtIn?: { actions?: ReadonlyArray<StepLike> | null } | null;
  } | null;
  actions?: ReadonlyArray<StepLike> | null;
};
type StepLike = { type?: string | null; adeAction?: { domain?: string | null; action?: string | null } | null };

/** The features in a draft its machine's ADE is too old to run, oldest requirement first. */
export function automationFeaturesNeedingNewerAde(
  draft: DraftLike | null | undefined,
  /** The machine's ADE version; null or empty when unknown or this window's own. */
  machineVersion: string | null | undefined,
): AutomationFeatureRequirement[] {
  const version = machineVersion?.trim();
  if (!draft || !version) return [];
  const needed = new Map<string, AutomationFeatureRequirement>();
  const consider = (key: string, requirement: AutomationFeatureRequirement | undefined) => {
    if (requirement && compareUpdateVersions(version, requirement.minVersion) < 0) needed.set(key, requirement);
  };
  const laneMode = draft.execution?.laneMode?.trim();
  if (laneMode) consider(`lane:${laneMode}`, LANE_MODE_MIN_VERSIONS[laneMode]);
  for (const step of [...(draft.actions ?? []), ...(draft.execution?.builtIn?.actions ?? [])]) {
    if (step?.type !== "ade-action") continue;
    const key = `${step.adeAction?.domain ?? ""}.${step.adeAction?.action ?? ""}`;
    consider(`action:${key}`, ACTION_MIN_VERSIONS[key]);
  }
  return [...needed.values()].sort((a, b) => compareUpdateVersions(a.minVersion, b.minVersion));
}

/**
 * Plain words for the error an older ADE gives for an action it does not have.
 * Returns null for any other error, which the caller shows as it is.
 */
export function explainAutomationActionError(message: string, machineName?: string | null): string | null {
  const match = /action_not_callable[^']*'([^']+)'/i.exec(message) ?? /Action '([^']+)' is not callable/i.exec(message);
  if (!match) return null;
  const known = ACTION_MIN_VERSIONS[match[1]!];
  const where = machineName?.trim() ? `the ADE on ${machineName.trim()}` : "the ADE that runs this rule";
  return known
    ? `${known.label} needs ADE ${known.minVersion} or newer, and ${where} is older. Update it, then try again.`
    : `${where[0]!.toUpperCase()}${where.slice(1)} does not have this step yet. Update it, then try again.`;
}
