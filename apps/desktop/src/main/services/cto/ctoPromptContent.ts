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
    "# ADE Operator Tools",
    "",
    "Use the registered ADE operator tool schemas as the authoritative capability reference. Their schemas are always loaded for CTO sessions, so their descriptions are not duplicated here.",
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
  ].join("\n");
}
