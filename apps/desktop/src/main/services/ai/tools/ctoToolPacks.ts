/**
 * The closed list of CTO tool packs, and nothing else.
 *
 * It lives apart from `ctoOperatorTools.ts` for the same reason `domains.ts`
 * lives apart from the action registry: the tool module pulls in zod, the model
 * registry and several service modules, while the CTO's prompt content needs
 * only the names and scopes. A file with zero imports can be read by both
 * without dragging the runtime graph into the prompt builder.
 *
 * `core` is the CTO's standing surface. It is always loaded BY CONSTRUCTION:
 * `alwaysLoad` is derived from the pack in `createCtoOperatorTools`, never set
 * per tool, so a core tool cannot ship un-loaded because someone forgot a flag.
 *
 * Every other pack is an extension: its tools stay registered and callable on
 * every transport, but their descriptions are trimmed to one line until
 * `loadCtoTools` is called for that pack. That is the deferral mechanism for
 * providers with no native one (Cursor, Droid, OpenCode); Codex layers
 * `deferLoading` on top and Claude layers ToolSearch.
 */
export const CTO_TOOL_PACK_NAMES = [
  "core",
  "linear",
  "files",
  "tests",
  "conflicts",
  "scheduling",
  "proof",
  "review",
  "search",
  "insights",
  "config",
  "devices",
  "orchestration",
] as const;

export type CtoToolPack = (typeof CTO_TOOL_PACK_NAMES)[number];

/** One line per pack, reused verbatim by the capability manifest. */
export const CTO_TOOL_PACK_SCOPES: Record<CtoToolPack, string> = {
  core: "lanes, chats, steering, session lifecycle, git, PRs, automations, handoff, memory, events",
  linear: "Linear issues: read, comment, state, assignee, labels",
  files: "lane file workspaces: tree, read, text search, ADE source search",
  tests: "ADE test suites: list, run, stop, logs",
  conflicts: "cross-lane conflict prediction, proposals, merge simulation",
  scheduling: "durable scheduled work: create, list, cancel, pause",
  proof: "computer-use proof artifacts: list, preview, capture, review",
  review: "ADE code-review runs: launch context, start, rerun, cancel, read, quality report",
  search: "project-wide universal search over ADE's own index",
  insights: "usage, spend, and budget reads",
  config: "project config reads and secret NAMES (never secret values)",
  devices: "iOS simulator, desktop app control, and built-in browser reads",
  orchestration: "orchestration run and bundle reads",
};

export function isCtoToolPack(value: unknown): value is CtoToolPack {
  return typeof value === "string" && (CTO_TOOL_PACK_NAMES as readonly string[]).includes(value);
}
