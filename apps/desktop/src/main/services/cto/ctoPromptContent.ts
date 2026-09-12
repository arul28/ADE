import { CTO_TOOL_PACK_NAMES, CTO_TOOL_PACK_SCOPES } from "../ai/tools/ctoToolPacks";

/**
 * Onboarding step id that records the CTO's opening turn. Not a user-facing
 * setup step — it lives in the same list so it is persisted and so
 * `resetOnboarding` clears it alongside the rest.
 */
export const CTO_INTRO_ONBOARDING_STEP = "intro";

/**
 * The first message in a brand-new CTO thread, sent as a real, visible user
 * turn. It is deliberately not hidden: ADE has no hidden-turn mechanism, and a
 * canned assistant message would be a fabricated transcript entry that then
 * feeds back into the model's context on every later turn. A visible prompt is
 * honest about what happened and costs nothing extra.
 */
export const CTO_INTRO_PROMPT = [
  "Introduce yourself: who you are, what you can do for me in this project, and how your memory works across model switches.",
  "Then scan the project and tell me what you actually see — lanes, open PRs, anything blocked — and what you would look at first.",
  "Keep it short.",
].join(" ");

export function buildCtoCapabilityManifest(): string {
  return [
    "# ADE operator tools",
    "",
    "Use the registered ADE operator tool schemas as the authoritative capability reference. Their schemas are registered for CTO sessions, so their descriptions are not duplicated here.",
    "",
    "# Tool packs",
    "",
    "Every ADE domain is reachable from this session. The core pack is always loaded; every other pack stays callable but",
    "carries a one-line description until you load it, so the tool list stays affordable. Call loadCtoTools with a pack name",
    "to get its full descriptions and input contracts, or with no argument to see which packs are loaded.",
    "",
    ...CTO_TOOL_PACK_NAMES.map((pack) => (
      pack === "core"
        ? `- ${pack}: ${CTO_TOOL_PACK_SCOPES[pack]} — always loaded.`
        : `- ${pack}: ${CTO_TOOL_PACK_SCOPES[pack]} — loads on first use.`
    )),
    "",
    "# Operating Rules",
    "",
    "- Internal ADE actions run through service-backed tools even when no renderer click occurs.",
    "- UI navigation is suggestion-only. When an action should open in ADE, return an explicit navigation suggestion instead of silently switching tabs.",
    "- Treat ADE as your operating environment. Do not describe yourself as blocked on renderer button clicks when an internal tool can do the work.",
    "- When multiple tools exist for similar purposes, prefer the higher-level one (e.g., createPrFromLane over manual git commands).",
    "- Never launch implementation work on your own lane. Your session is pinned to the project's primary lane, and agents working there would write straight to the primary worktree.",
    "- When the user does not name a lane, let the work get a dedicated lane: call spawnChat without laneId (it creates one), or createLane first and pass that id. Only pass laneId when the user named an existing lane.",
    "- Read-only inspection (status, listing chats, reading files, git status) may target any lane, including your own.",
    "- For model-specific requests, always resolve the user's model name to the full modelId before calling spawnChat.",
    "- Never say a thing cannot be done because you lack a tool for it until you have checked loadCtoTools for the pack that would own it.",
    "- Secret VALUES are not readable by any tool you have, by design. You can list secret names; the user reads values themselves in Settings.",
    "- Destructive tools (deleting an automation rule, cancelling scheduled work, replacing an existing rule) ask the user to confirm before they run. Expect the pause.",
  ].join("\n");
}

/**
 * Onboarding step id recording that the nightly memory gardener job was
 * created. It is the idempotency key, not a UI step: once it is set the job is
 * never created again, so a user who pauses or deletes the job keeps that
 * decision instead of having ADE quietly re-arm it on the next CTO open.
 */
export const CTO_MEMORY_GARDENER_ONBOARDING_STEP = "memory_gardener";

/** Title shown for the gardener in Chat Info's scheduled-work list. */
export const CTO_MEMORY_GARDENER_TITLE = "Nightly memory gardening";

/**
 * 03:30 in the ADE brain machine's local timezone — after the day's work has
 * settled and before anyone is reading the morning briefing.
 */
export const CTO_MEMORY_GARDENER_CRON = "30 3 * * *";

/**
 * The gardener's fixed prompt. It lives here rather than at the creation site
 * so the job's behavior is reviewable in one place and a running job's prompt
 * can be diffed against the current definition.
 */
export const CTO_MEMORY_GARDENER_PROMPT = [
  "Nightly memory gardening. Work quietly: no questions, no lane work, no spawned chats.",
  "",
  "1. Read the recent daily logs and the worker discovery log, and distill anything durable into facts with saveMemory. Tag every fact you write (lane, pr, path, topic) so it can be found later.",
  "2. Merge duplicates: when several facts say the same thing, write one clear replacement and drop the rest with updateMemory.",
  "3. Archive stale facts: any fact whose PR merged more than 30 days ago is history, not operating context — remove it from durable memory.",
  "4. Leave everything you are unsure about exactly as it is. Losing a fact is worse than keeping a redundant one.",
  "",
  "Finish with one short line naming how many facts you added, merged, and archived.",
].join("\n");
