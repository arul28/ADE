/**
 * Agent identity labels, apart from the rest of `chatSubagents` so a card that
 * names an agent does not load the whole subagent model at startup.
 */
export type AgentIdentityLabel = {
  /** Human role, sentence case — "Ship poller". */
  label: string;
  /** Trailing issue/PR number lifted out of the path, e.g. "#927". */
  ref: string | null;
  /** The raw value, kept for the `title` tooltip. */
  raw: string;
};

/**
 * Words an agent id spells in lower case that read wrong in sentence case:
 * `ios_shared_scan` is "iOS shared scan", not "Ios shared scan". Mirrored on
 * iOS in `WorkStatusAndFormattingHelpers.swift`.
 */
const AGENT_IDENTITY_ACRONYMS: ReadonlyMap<string, string> = new Map(
  ["iOS", "CLI", "TUI", "UI", "UX", "API", "IPC", "PR", "CI", "SDK", "MCP", "DB", "JSON", "URL", "HTTP", "SQL", "CSS", "HTML", "AI", "ID"]
    .map((word) => [word.toLowerCase(), word] as const),
);

/**
 * Turn a runtime's internal agent path into a role.
 *
 * Codex hands us `/ROOT/SHIP_POLL_927` — an id, not an identity. Identity
 * should read as role + intent, so the last segment becomes sentence case
 * ("Ship poll") and a trailing issue/PR number is lifted into `ref`.
 * Runtimes that never set an agent type (OpenCode, Droid) get `null`.
 */
export function humanizeAgentIdentity(value: string | null | undefined): AgentIdentityLabel | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  // `background` is a flag the spawn card renders as its own chip.
  if (raw.toLowerCase() === "background") return null;
  const segments = raw.split(/[/\\]+/).filter((segment) => segment.length > 0);
  let tail = segments.length ? segments[segments.length - 1]! : raw;
  // A bare "/root" (or an all-separator value) carries no role at all.
  if (segments.length === 1 && /^root$/i.test(tail)) return null;
  let ref: string | null = null;
  const numberMatch = tail.match(/[_\-\s](\d{2,})$/);
  if (numberMatch) {
    ref = `#${numberMatch[1]}`;
    tail = tail.slice(0, numberMatch.index);
  }
  const words = tail.split(/[_\-\s]+/).filter((word) => word.length > 0);
  if (!words.length) return ref ? { label: raw, ref, raw } : null;
  const label = words
    .map((word, index) => {
      const acronym = AGENT_IDENTITY_ACRONYMS.get(word.toLowerCase());
      if (acronym) return acronym;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
  return { label, ref, raw };
}
