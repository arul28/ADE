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
  PluginActionSubject,
  PluginAutomationContext,
  PluginDialogContext,
  PluginLaneContext,
  PluginPrContext,
  PluginSessionContext,
} from "../../../../shared/plugins/context";
import type { PluginDialogKind } from "../../../../shared/plugins/sockets";

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

/**
 * One of ADE's dialogs, for a `dialog-section`.
 *
 * Every field is what the dialog holds RIGHT NOW rather than when it opened —
 * the section invokes with whatever this last built, and a plugin filling in a
 * branch name should see the lane the user just renamed. Empty strings fold to
 * null so "the user has typed nothing yet" and "there is nothing to type" read
 * the same to a plugin.
 */
export function pluginDialogContext(input: {
  dialog: PluginDialogKind;
  laneId?: string | null;
  laneName?: string | null;
  branch?: string | null;
  projectKey?: string | null;
}): PluginDialogContext {
  return {
    kind: "dialog",
    dialog: input.dialog,
    laneId: input.laneId || null,
    laneName: input.laneName || null,
    branch: branchName(input.branch),
    projectKey: input.projectKey || null,
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

/**
 * What the reader is looking at, for a control that has no row of its own.
 *
 * The palette's answer to "which chat am I in". Pure, like every other builder
 * here: the caller reads the live store and hands over the two candidates, so
 * this file keeps having no opinion about where ADE keeps its state.
 *
 * The focused chat wins over the selected lane, because a chat is the narrower
 * of the two and names its lane already. Neither is `{kind: "none"}`, which is
 * a real answer — the palette over the Files tab of a project with no lane
 * selected has no subject, and a plugin told so can say "open a chat first"
 * instead of acting on a guess.
 */
export function pluginActionSubject(input: {
  session: {
    id: string;
    title?: string | null;
    goal?: string | null;
    toolType?: string | null;
    runtimeState?: string | null;
  } | null;
  lane: {
    id: string;
    name: string;
    branchRef?: string | null;
    status?: { dirty?: boolean } | null;
  } | null;
}): PluginActionSubject {
  if (input.session) {
    return pluginSessionContext({
      id: input.session.id,
      title: input.session.goal ?? input.session.title,
      provider: input.session.toolType,
      status: input.session.runtimeState,
    });
  }
  if (input.lane) return pluginLaneContext(input.lane);
  return { kind: "none" };
}
