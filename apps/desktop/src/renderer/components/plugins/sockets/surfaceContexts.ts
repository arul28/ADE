/**
 * Builders for the typed contexts a socket hands a plugin.
 *
 * Each of the six surfaces already has the row data in scope; what it does not
 * have is agreement with the other five about which fields a plugin sees and
 * what they are called. These builders are that agreement — the projection from
 * ADE's internal models to `shared/plugins/context` happens in one file, so
 * widening what a plugin can see is a change here rather than five call sites
 * quietly drifting apart.
 */

import type {
  PluginAutomationContext,
  PluginLaneContext,
  PluginPrContext,
  PluginSessionContext,
} from "../../../../shared/plugins/context";

/** `refs/heads/x` → `x`. Remote prefixes are left alone: they are a different ref. */
function branchName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const trimmed = ref.replace(/^refs\/heads\//, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function pluginLaneContext(
  lane: { id: string; name: string; branchRef?: string | null; status?: { dirty?: boolean } | null },
  options: { machineKey?: string | null } = {},
): PluginLaneContext {
  return {
    kind: "lane",
    id: lane.id,
    name: lane.name,
    branch: branchName(lane.branchRef),
    machineKey: options.machineKey ?? null,
    dirty: lane.status?.dirty === true,
  };
}

export function pluginPrContext(pr: {
  number: number;
  title?: string | null;
  branch?: string | null;
  headRefName?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  ciStatus?: PluginPrContext["ciStatus"];
}): PluginPrContext {
  const state = pr.isDraft
    ? "draft"
    : pr.state === "OPEN" || pr.state === "open"
      ? "open"
      : pr.state === "MERGED" || pr.state === "merged"
        ? "merged"
        : pr.state === "CLOSED" || pr.state === "closed"
          ? "closed"
          : "unknown";
  return {
    kind: "pr",
    number: pr.number,
    title: pr.title ?? "",
    branch: pr.branch ?? pr.headRefName ?? null,
    state,
    ciStatus: pr.ciStatus ?? "unknown",
  };
}

export function pluginSessionContext(session: {
  id: string;
  title?: string | null;
  provider?: string | null;
  status?: string | null;
}): PluginSessionContext {
  return {
    kind: "session",
    id: session.id,
    title: session.title ?? "",
    provider: session.provider ?? null,
    status: session.status ?? null,
  };
}

export function pluginAutomationContext(rule: {
  id: string;
  name?: string | null;
  enabled?: boolean;
}): PluginAutomationContext {
  return {
    kind: "automation",
    id: rule.id,
    // An unnamed rule renders as "Untitled automation" in the list; a plugin
    // showing a blank name for the same row would look like a plugin bug.
    name: rule.name?.trim() || "Untitled automation",
    enabled: rule.enabled !== false,
  };
}
