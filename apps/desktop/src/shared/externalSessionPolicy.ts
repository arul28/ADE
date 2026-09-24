import {
  EXTERNAL_SESSION_PROVIDER_LABELS,
  type ExternalSessionCapabilities,
  type ExternalSessionHome,
  type ExternalSessionProvider,
  type ExternalSessionSummary,
} from "./types/externalSessions";

/**
 * Which lanes an import action may target.
 *
 * - `any`: any lane.
 * - `home`: only the session's home lane. A session with no live home lane
 *   (outside folder, removed lane) may go to any lane and runs in its folder.
 * - `root`: only the home lane, and only when the session folder is that
 *   lane's worktree root — ADE chats always run at the lane root.
 * - `none`: not offered.
 */
export type ImportLaneRule = "any" | "home" | "root" | "none";

export type ImportSurface = "chat" | "cli";

export type ProviderImportRules = {
  /** Continue the same provider session as an ADE chat. */
  chatContinue: ImportLaneRule;
  /** A new ADE chat with this history (native fork or full replay). */
  chatCopy: ImportLaneRule;
  /** Continue the same provider session in a tracked CLI terminal. */
  cliContinue: ImportLaneRule;
  /** A provider-native copy in a tracked CLI terminal. */
  cliCopy: ImportLaneRule;
};

/**
 * The provider table. Dynamic capabilities from the host can only narrow it
 * (see `effectiveImportRules`).
 *
 * Chat continue for Droid, OpenCode and Pi seeds the provider's own session
 * pointer — the same restore path ADE's own chats use after a restart. The
 * ACP providers and Cursor stay `none` until a live run proves their CLI can
 * load a session the CLI itself created; chat mode offers the replay copy.
 */
export const PROVIDER_IMPORT_RULES: Record<ExternalSessionProvider, ProviderImportRules> = {
  claude: { chatContinue: "root", chatCopy: "any", cliContinue: "home", cliCopy: "any" },
  codex: { chatContinue: "any", chatCopy: "any", cliContinue: "any", cliCopy: "any" },
  cursor: { chatContinue: "none", chatCopy: "any", cliContinue: "home", cliCopy: "none" },
  droid: { chatContinue: "root", chatCopy: "any", cliContinue: "home", cliCopy: "any" },
  opencode: { chatContinue: "root", chatCopy: "any", cliContinue: "home", cliCopy: "home" },
  pi: { chatContinue: "root", chatCopy: "any", cliContinue: "home", cliCopy: "home" },
  qwen: { chatContinue: "none", chatCopy: "any", cliContinue: "home", cliCopy: "home" },
  kimi: { chatContinue: "none", chatCopy: "any", cliContinue: "home", cliCopy: "none" },
  grok: { chatContinue: "none", chatCopy: "any", cliContinue: "home", cliCopy: "home" },
  copilot: { chatContinue: "root", chatCopy: "any", cliContinue: "home", cliCopy: "none" },
};

const RULE_RANK: Record<ImportLaneRule, number> = { none: 0, root: 1, home: 2, any: 3 };

function narrower(left: ImportLaneRule, right: ImportLaneRule): ImportLaneRule {
  return RULE_RANK[left] <= RULE_RANK[right] ? left : right;
}

/**
 * The provider table narrowed by what the host reported for this session: a
 * missing source folder, a droid without `--fork`.
 */
export function effectiveImportRules(
  summary: Pick<ExternalSessionSummary, "provider" | "capabilities">,
): ProviderImportRules {
  const base = PROVIDER_IMPORT_RULES[summary.provider];
  const cap: ExternalSessionCapabilities = summary.capabilities;
  const cliContinueCap: ImportLaneRule = cap.resumeInDifferentCwd
    ? "any"
    : cap.resumeInPlace
      ? "home"
      : "none";
  const cliCopyCap: ImportLaneRule = cap.forkIntoDifferentCwd
    ? "any"
    : cap.fork
      ? "home"
      : "none";
  return {
    chatContinue: cap.importToChat ? base.chatContinue : "none",
    // The list already hides sessions with no prompts; an empty replay is
    // refused by the chat importer itself.
    chatCopy: base.chatCopy,
    cliContinue: narrower(base.cliContinue, cliContinueCap),
    cliCopy: narrower(base.cliCopy, cliCopyCap),
  };
}

function homeLaneId(home: ExternalSessionHome | null | undefined): string | null {
  return home?.kind === "lane" && home.laneId ? home.laneId : null;
}

/** Whether `rule` lets an action target `targetLaneId` for this session. */
export function laneRuleAllows(
  rule: ImportLaneRule,
  home: ExternalSessionHome | null | undefined,
  targetLaneId: string | null,
): boolean {
  if (rule === "none") return false;
  if (rule === "any") return true;
  const homeId = homeLaneId(home);
  if (rule === "home") return homeId == null || homeId === targetLaneId;
  return homeId != null && homeId === targetLaneId && home?.atLaneRoot === true;
}

/** Whether `rule` can reach any lane other than the home lane. */
function ruleReachesOtherLanes(rule: ImportLaneRule, home: ExternalSessionHome | null | undefined): boolean {
  if (rule === "any") return true;
  if (rule === "home") return homeLaneId(home) == null;
  return false;
}

export type ImportPlanAction = {
  target: ImportSurface;
  /** Wire value for `ExternalSessionImportArgs.mode`. */
  mode: "resume" | "fork";
  label: string;
  /** A chat copy lets the user pick the model. */
  needsModel: boolean;
  /**
   * Continuing a session that may still be open elsewhere asks for a second
   * press before it runs; two writers on one provider session corrupt it.
   */
  confirmBeforeRun: boolean;
};

export type ImportPlan = {
  /** Surfaces that have at least one action for some lane. */
  surfaces: ImportSurface[];
  /** The surface this plan describes (the requested one, else the first available). */
  surface: ImportSurface | null;
  /** The lane the actions run against after locking. */
  targetLaneId: string | null;
  laneLocked: boolean;
  lockReason: string | null;
  primary: ImportPlanAction | null;
  secondary: ImportPlanAction | null;
  /** One short line under the action bar, or null. */
  note: string | null;
};

export type PlanImportOptions = {
  surface?: ImportSurface | null;
  targetLaneId: string | null;
  /** Lane names for notes; falls back to the home lane name on the summary. */
  laneName?: (laneId: string) => string | null;
};

function rulesForSurface(rules: ProviderImportRules, surface: ImportSurface) {
  return surface === "chat"
    ? { resume: rules.chatContinue, fork: rules.chatCopy }
    : { resume: rules.cliContinue, fork: rules.cliCopy };
}

function surfaceHasActions(rules: ProviderImportRules, surface: ImportSurface): boolean {
  const pair = rulesForSurface(rules, surface);
  return pair.resume !== "none" || pair.fork !== "none";
}

export function importProviderLabel(provider: ExternalSessionProvider): string {
  return EXTERNAL_SESSION_PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Everything the action bar shows, for one session, surface and target lane.
 * Every client renders this plan as-is; no client decides on its own which
 * actions exist.
 */
export function planImport(
  summary: Pick<
    ExternalSessionSummary,
    "provider" | "capabilities" | "home" | "possiblyActive" | "cwdMatchesRequestedLane"
  >,
  options: PlanImportOptions,
): ImportPlan {
  const rules = effectiveImportRules(summary);
  const surfaces = (["chat", "cli"] as const).filter((surface) => surfaceHasActions(rules, surface));
  const surface = options.surface && surfaces.includes(options.surface)
    ? options.surface
    : surfaces[0] ?? null;
  const empty: ImportPlan = {
    surfaces: [...surfaces],
    surface,
    targetLaneId: options.targetLaneId,
    laneLocked: false,
    lockReason: null,
    primary: null,
    secondary: null,
    note: null,
  };
  if (!surface) return empty;

  const home = summary.home ?? null;
  const homeId = homeLaneId(home);
  const pair = rulesForSurface(rules, surface);
  const laneLocked = homeId != null
    && !ruleReachesOtherLanes(pair.resume, home)
    && !ruleReachesOtherLanes(pair.fork, home);
  const targetLaneId = laneLocked ? homeId : options.targetLaneId;
  const providerLabel = importProviderLabel(summary.provider);
  const nameOf = (laneId: string | null): string | null => {
    if (!laneId) return null;
    return options.laneName?.(laneId) ?? (laneId === homeId ? home?.laneName ?? null : null);
  };

  const canContinue = laneRuleAllows(pair.resume, home, targetLaneId);
  const canCopy = laneRuleAllows(pair.fork, home, targetLaneId);
  const awayFromHome = homeId != null && targetLaneId !== homeId;

  const continueAction: ImportPlanAction = {
    target: surface,
    mode: "resume",
    label: "Continue",
    needsModel: false,
    confirmBeforeRun: summary.possiblyActive === true,
  };
  const copyAction = (label: string): ImportPlanAction => ({
    target: surface,
    mode: "fork",
    label,
    needsModel: surface === "chat",
    confirmBeforeRun: false,
  });

  let primary: ImportPlanAction | null = null;
  let secondary: ImportPlanAction | null = null;
  if (canContinue) {
    primary = continueAction;
    if (canCopy) secondary = copyAction("Copy");
  } else if (canCopy) {
    primary = copyAction(surface === "chat" ? "Open as ADE chat" : awayFromHome ? "Copy here" : "Copy");
  }

  let note: string | null = null;
  if (primary?.mode === "resume" && summary.possiblyActive) {
    note = "Open elsewhere — close it there first.";
  } else if (primary?.mode === "fork" && awayFromHome && nameOf(homeId)) {
    note = `Original stays in ${nameOf(homeId)}.`;
  } else if (
    primary?.mode === "resume"
    && surface === "cli"
    && pair.resume !== "any"
    && homeId == null
    // An older host sends no `home`; its folder check is the only signal
    // that the session runs somewhere other than the chosen lane.
    && (home != null || summary.cwdMatchesRequestedLane === false)
  ) {
    note = "Runs in its original folder.";
  }

  return {
    surfaces: [...surfaces],
    surface,
    targetLaneId,
    laneLocked,
    lockReason: laneLocked ? `${providerLabel} sessions stay in their own lane.` : null,
    primary,
    secondary,
    note,
  };
}

/**
 * Host-side guard: the import the client asked for must be one the plan
 * offers. Returns a plain-language reason when it is not.
 */
export function importRejectionReason(
  summary: Pick<ExternalSessionSummary, "provider" | "capabilities" | "home">,
  request: { target: ImportSurface; mode: "resume" | "fork"; laneId: string },
): string | null {
  const rules = effectiveImportRules(summary);
  const pair = rulesForSurface(rules, request.target);
  const rule = request.mode === "resume" ? pair.resume : pair.fork;
  const label = importProviderLabel(summary.provider);
  if (rule === "none") {
    const what = request.target === "chat"
      ? request.mode === "resume" ? "continued as an ADE chat" : "opened as an ADE chat"
      : request.mode === "resume" ? "continued in a terminal" : "copied in a terminal";
    return `This ${label} session can't be ${what}.`;
  }
  if (!laneRuleAllows(rule, summary.home, request.laneId)) {
    const homeName = summary.home?.laneName;
    return homeName
      ? `This ${label} session can only do that in ${homeName}.`
      : `This ${label} session can't do that in this lane.`;
  }
  return null;
}
