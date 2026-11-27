/**
 * Automation features a rule's machine must be new enough to run.
 *
 * A rule is saved to, and runs on, the machine it names, and that machine can
 * run an older ADE than the window editing it. The machine's brain says what
 * it supports (`automations.getCapabilities`); a brain older than that call is
 * judged by the version table below instead. Without either the builder
 * offered a step the machine's ADE does not have, and the first sign was a raw
 * `action_not_callable` after a click.
 *
 * Add a row when a step type, an ADE action an automation can call, a trigger,
 * or a lane mode first ships, with the first release that has it. A brain with
 * `getCapabilities` does not need the row; it only names the release to
 * update to, and covers machines older than the call.
 */

import type { AutomationCapabilities } from "./types";
import { compareUpdateVersions } from "./updateVersions";
import { BRAND } from "./brand";

export type AutomationFeatureKind = "trigger" | "step" | "laneMode" | "adeAction" | "cloudLanes" | "notifyLink";

/**
 * The `notifyLink` id of "This run's history". It shipped with
 * `getCapabilities`: a sender older than that drops the link it cannot parse.
 */
export const AUTOMATION_RUN_LINK_ID = "automation-run";

export type AutomationFeatureRequirement = {
  /** `kind:id`, unique per feature. */
  key: string;
  /** What the user sees, e.g. "Send notification to mobile app". */
  label: string;
  /** The first release that has it; null when unknown. */
  minVersion: string | null;
};

/**
 * What is known about the ADE on the rule's machine: its own answer, else its
 * brain version. Null for this window's own machine, which runs this build.
 */
export type AutomationMachineSupport = {
  capabilities: AutomationCapabilities | null;
  /** The brain's version, bare; null when unknown. */
  version: string | null;
} | null;

type VersionRow = { label: string; minVersion: string };

/** ADE actions an automation step can call, by `domain.action`. */
const ACTION_MIN_VERSIONS: Record<string, VersionRow> = {
  "attention.sendNotification": { label: "Send notification to mobile app", minVersion: "1.2.96" },
};

/** Lane modes ("Run in"). */
const LANE_MODE_MIN_VERSIONS: Record<string, VersionRow> = {
  "pr-branch": { label: "Run in the PR's branch", minVersion: "1.2.95" },
};

/** Triggers ("When"). */
const TRIGGER_MIN_VERSIONS: Record<string, VersionRow> = {
  "session.settled": { label: "When a chat is settled", minVersion: "1.2.101" },
  "github.pr_checks_failed": { label: "When a PR's checks fail", minVersion: "1.2.126" },
};

/** The one id of the `cloudLanes` feature, which has no variants. */
export const AUTOMATION_CLOUD_LANES_ID = "cloud";

/** "Run on ADE Cloud" for each run's lane. */
const CLOUD_LANES_ROW: VersionRow = { label: `Run on ${BRAND.CLOUD_NAME}`, minVersion: "1.2.130-beta.12" };

function versionRow(kind: AutomationFeatureKind, id: string): VersionRow | undefined {
  switch (kind) {
    case "trigger": return TRIGGER_MIN_VERSIONS[id];
    // Every step type in the add menu predates the version table; add a table
    // here when one ships later.
    case "step": return undefined;
    case "laneMode": return LANE_MODE_MIN_VERSIONS[id];
    case "adeAction": return ACTION_MIN_VERSIONS[id];
    case "cloudLanes": return CLOUD_LANES_ROW;
    case "notifyLink": return undefined;
  }
}

function listedByCapabilities(capabilities: AutomationCapabilities, kind: AutomationFeatureKind, id: string): boolean {
  switch (kind) {
    case "trigger": return capabilities.triggerTypes.includes(id);
    case "step": return capabilities.stepTypes.includes(id);
    case "laneMode": return capabilities.laneModes.includes(id);
    // An unknown list (the brain had not bound its actions) is not a refusal.
    case "adeAction": return capabilities.adeActions == null || capabilities.adeActions.includes(id);
    case "cloudLanes": return capabilities.cloudLanes;
    // Every brain that answers `getCapabilities` parses run links.
    case "notifyLink": return id === AUTOMATION_RUN_LINK_ID;
  }
}

/**
 * The requirement a feature has that the machine does not meet, or null when
 * the machine has it (or nothing says it lacks it). `label` names a feature
 * the version table has no row for.
 */
export function automationFeatureMissing(
  support: AutomationMachineSupport,
  kind: AutomationFeatureKind,
  id: string,
  label?: string | null,
): AutomationFeatureRequirement | null {
  if (!support) return null;
  const row = versionRow(kind, id);
  const version = support.version?.trim() || null;
  const olderThanRow = Boolean(row && version && compareUpdateVersions(version, row.minVersion) < 0);
  const missing = support.capabilities
    ? !listedByCapabilities(support.capabilities, kind, id)
    // A notification link kind newer than the version table needs the
    // machine's own answer.
    : kind === "notifyLink" || olderThanRow;
  if (!missing) return null;
  return {
    key: `${kind}:${id}`,
    label: row?.label ?? label?.trim() ?? id,
    // Name a release only when it is the reason: a machine past it lacks the
    // feature for another reason (a build without it).
    minVersion: row && (olderThanRow || !version) ? row.minVersion : null,
  };
}

type DraftLike = {
  triggers?: ReadonlyArray<{ type?: string | null }> | null;
  execution?: {
    kind?: string | null;
    laneMode?: string | null;
    cloud?: unknown;
    builtIn?: { actions?: ReadonlyArray<StepLike> | null } | null;
  } | null;
  actions?: ReadonlyArray<StepLike> | null;
};
type StepLike = {
  type?: string | null;
  adeAction?: { domain?: string | null; action?: string | null; args?: unknown } | null;
};

/** The features in a draft its machine's ADE cannot run, oldest requirement first. */
export function automationFeaturesNeedingNewerAde(
  draft: DraftLike | null | undefined,
  support: AutomationMachineSupport,
  labelFor?: (kind: AutomationFeatureKind, id: string) => string | null | undefined,
): AutomationFeatureRequirement[] {
  if (!draft || !support) return [];
  const needed = new Map<string, AutomationFeatureRequirement>();
  const consider = (kind: AutomationFeatureKind, id: string | null | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed) return;
    const missing = automationFeatureMissing(support, kind, trimmed, labelFor?.(kind, trimmed));
    if (missing) needed.set(missing.key, missing);
  };
  for (const trigger of draft.triggers ?? []) consider("trigger", trigger?.type);
  consider("laneMode", draft.execution?.laneMode);
  if (draft.execution?.cloud) consider("cloudLanes", AUTOMATION_CLOUD_LANES_ID);
  if (draft.execution?.kind === "agent-session") consider("step", "agent-session");
  for (const step of [...(draft.actions ?? []), ...(draft.execution?.builtIn?.actions ?? [])]) {
    consider("step", step?.type);
    if (step?.type !== "ade-action") continue;
    consider("adeAction", `${step.adeAction?.domain ?? ""}.${step.adeAction?.action ?? ""}`);
    const open = (step.adeAction?.args as { open?: unknown } | null | undefined)?.open;
    if (typeof open === "string" && BRAND.LINK_SCHEMES.some((scheme) => open.trim().toLowerCase().startsWith(`${scheme}://${AUTOMATION_RUN_LINK_ID}/`))) consider("notifyLink", AUTOMATION_RUN_LINK_ID);
  }
  return [...needed.values()].sort((a, b) => {
    if (a.minVersion && b.minVersion) return compareUpdateVersions(a.minVersion, b.minVersion);
    return a.minVersion ? -1 : b.minVersion ? 1 : 0;
  });
}

/** One line for a feature the machine lacks: "Needs ADE 1.2.96 on Mac Studio". */
export function automationFeatureGateReason(requirement: AutomationFeatureRequirement, machineName?: string | null): string {
  const where = machineName?.trim() ? ` on ${machineName.trim()}` : " on the machine that runs this rule";
  return requirement.minVersion
    ? `Needs ${BRAND.NAME} ${requirement.minVersion}${where}`
    : `Needs a newer ${BRAND.NAME}${where}`;
}

/**
 * Plain words for the error an older ADE gives for an action it does not have.
 * Returns null for any other error, which the caller shows as it is.
 */
export function explainAutomationActionError(message: string, machineName?: string | null): string | null {
  const match = /action_not_callable[^']*'([^']+)'/i.exec(message) ?? /Action '([^']+)' is not callable/i.exec(message);
  if (!match) return null;
  const known = ACTION_MIN_VERSIONS[match[1]!];
  const where = machineName?.trim() ? `the ${BRAND.NAME} on ${machineName.trim()}` : `the ${BRAND.NAME} that runs this rule`;
  return known
    ? `${known.label} needs ${BRAND.NAME} ${known.minVersion} or newer, and ${where} is older. Update it, then try again.`
    : `${where[0]!.toUpperCase()}${where.slice(1)} does not have this step yet. Update it, then try again.`;
}
