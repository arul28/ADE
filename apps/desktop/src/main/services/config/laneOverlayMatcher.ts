import type { LaneOverlayOverrides, LaneOverlayPolicy, LaneSummary } from "../../../shared/types";

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim();
  if (!normalized.length) return /^$/;
  const parts = normalized.split("*").map((chunk) => escapeRegExp(chunk));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

function normalizeSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function intersectOrAdopt(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (!next || next.length === 0) return current;
  if (!current || current.length === 0) return [...next];
  const allowed = new Set(next);
  return current.filter((entry) => allowed.has(entry));
}

function matchesPolicy(lane: LaneSummary, policy: LaneOverlayPolicy): boolean {
  if (!policy.enabled) return false;
  const match = policy.match ?? {};

  if (match.laneIds && match.laneIds.length > 0 && !match.laneIds.includes(lane.id)) {
    return false;
  }
  if (match.laneTypes && match.laneTypes.length > 0 && !match.laneTypes.includes(lane.laneType)) {
    return false;
  }
  if (match.namePattern) {
    const pattern = globToRegExp(match.namePattern);
    if (!pattern.test(lane.name)) return false;
  }
  if (match.branchPattern) {
    const pattern = globToRegExp(match.branchPattern);
    if (!pattern.test(lane.branchRef)) return false;
  }
  if (match.tags && match.tags.length > 0) {
    const laneTags = normalizeSet(lane.tags);
    const required = normalizeSet(match.tags);
    const hasOverlap = [...required].some((tag) => laneTags.has(tag));
    if (!hasOverlap) return false;
  }

  return true;
}

export function matchLaneOverlayPolicies(lane: LaneSummary, policies: LaneOverlayPolicy[]): LaneOverlayOverrides {
  const merged: LaneOverlayOverrides = {};

  for (const policy of policies) {
    if (!matchesPolicy(lane, policy)) continue;
    const overrides = policy.overrides ?? {};
    if (overrides.env) {
      merged.env = {
        ...(merged.env ?? {}),
        ...overrides.env
      };
    }
    if (typeof overrides.cwd === "string" && overrides.cwd.trim().length > 0) {
      merged.cwd = overrides.cwd.trim();
    }
    merged.processIds = intersectOrAdopt(merged.processIds, overrides.processIds);
    merged.testSuiteIds = intersectOrAdopt(merged.testSuiteIds, overrides.testSuiteIds);
  }

  if (merged.processIds && merged.processIds.length === 0) {
    delete merged.processIds;
  }
  if (merged.testSuiteIds && merged.testSuiteIds.length === 0) {
    delete merged.testSuiteIds;
  }

  return merged;
}

