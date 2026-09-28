import type { AgentChatDevinCloudConfig } from "./types/chat";

/**
 * Devin Cloud over the ACP relay (`devin acp --cloud`): the version and
 * platform pickers, the session config a chat carries, and the branch pin a
 * cloud turn rides on. Provider-neutral cloud-lane tagging lives in
 * `./cloudLanes`.
 */

const DEVIN_SESSION_ID_PATTERN = /^(devin-)?[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * A caller-supplied Devin session id in its bare (web) form. Accepts the
 * relay's `devin-` prefixed form too. Throws on anything else, so an id never
 * reaches a CLI argument, a path or a URL unchecked.
 */
export function normalizeDevinCloudSessionId(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("Devin session id is required.");
  if (!DEVIN_SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error("Invalid Devin session id: use letters, digits, '-' or '_' (optionally prefixed with 'devin-').");
  }
  return trimmed.startsWith("devin-") ? trimmed.slice("devin-".length) : trimmed;
}

export type DevinCloudVersionOption = {
  /** `devin_version` config value. */
  value: string;
  label: string;
  /** One short line. */
  description: string;
  /** Small chip: "Free", "Preview", "2× cost"… */
  badge?: string;
};

/**
 * The `devin_version` values the cloud relay offered on 2026-09-28. The live
 * session's own list wins when ADE has one; this is the picker before a
 * session exists. Order is the order the picker shows.
 */
export const DEVIN_CLOUD_VERSIONS: readonly DevinCloudVersionOption[] = [
  { value: "devin-2-5", label: "Devin", description: "Default agent. Good at long-horizon work." },
  { value: "devin-auto", label: "Fusion", description: "Frontier planning, cheaper execution." },
  { value: "devin-fast-opus", label: "Devin Fast", description: "2.5× faster, 2× the cost.", badge: "Fast" },
  { value: "devin_lite", label: "Devin Lite", description: "Small, well-defined tasks. 60% cheaper.", badge: "Cheap" },
  { value: "devin-ultra", label: "Devin Ultra", description: "Hardest thinking. Much more expensive." },
  { value: "devin-swe-2-low", label: "SWE-2", description: "Cognition's newest model, medium effort.", badge: "Preview" },
  { value: "devin-swe-2-high", label: "SWE-2 High", description: "SWE-2 with more reasoning.", badge: "Preview" },
  { value: "devin-opus-5-5", label: "Opus 5.5", description: "Claude Opus 5.5 in the Devin harness.", badge: "Preview" },
  { value: "devin-gpt-6-sol", label: "GPT-6 Sol", description: "GPT-6 Sol in the Devin harness.", badge: "Preview" },
];

export const DEVIN_CLOUD_DEFAULT_VERSION = "devin-2-5";

export const DEVIN_CLOUD_PLATFORMS = [
  { value: "linux", label: "Ubuntu" },
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
] as const;

export function devinCloudVersionLabel(value: string | null | undefined): string {
  // Anything off the curated list is an internal codename (e.g. a
  // web-started session's pinned build); show the product name instead.
  const match = DEVIN_CLOUD_VERSIONS.find((option) => option.value === value);
  return match?.label ?? "Devin";
}

export function normalizeDevinCloudConfig(value: unknown): AgentChatDevinCloudConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.transport !== "acp") return null;
  const text = (key: string): string | null =>
    typeof record[key] === "string" && (record[key] as string).trim().length ? (record[key] as string).trim() : null;
  return {
    transport: "acp",
    version: text("version"),
    platform: text("platform"),
    repo: text("repo"),
    branch: text("branch"),
    ...(record.pinned === true ? { pinned: true } : {}),
  };
}

export function isDevinCloudAcpSession(
  session: { provider?: string | null; devinCloud?: AgentChatDevinCloudConfig | null } | null | undefined,
): boolean {
  return session?.provider === "devin" && session.devinCloud?.transport === "acp";
}

/**
 * Throws for a Devin Cloud chat linked over the retired Devin REST API: it has
 * no relay config, and sending or resuming must not fall through to a local
 * Devin run in the lane.
 */
export function assertDevinCloudChatHasRelay(
  session: { provider?: string | null; devinRuntime?: string | null; devinCloud?: AgentChatDevinCloudConfig | null },
): void {
  if (session.provider === "devin" && session.devinRuntime === "cloud" && !isDevinCloudAcpSession(session)) {
    throw new Error("This Devin Cloud chat was linked over the retired Devin API. Reopen the session from the Devin Cloud panel.");
  }
}

/**
 * A message with ADE's branch pin removed: what the user actually asked. The
 * pin rides the prompt, so the provider's own excerpt of a session starts
 * with it.
 */
export function stripDevinCloudBranchPin(text: string): string {
  if (!text.trimStart().startsWith("[ADE lane]")) return text;
  const markers = ["Open a pull request only if asked.", "commit and push work there."];
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at >= 0) return text.slice(at + marker.length).trim();
  }
  // Cut off inside the pin (an excerpt is truncated): nothing the user wrote
  // survived, so show nothing rather than ADE's own instructions.
  return "";
}

/**
 * The branch pin a Devin Cloud turn carries. Devin's session API has no branch
 * field, so the lane's branch rides the prompt: the first turn sets the VM up
 * on it, later turns keep it there. Kept short — it is read every turn.
 */
export function buildDevinCloudBranchPin(args: {
  repo: string | null;
  branch: string | null;
  firstTurn: boolean;
}): string | null {
  const branch = args.branch?.trim();
  if (!branch) return null;
  const repo = args.repo?.trim();
  if (args.firstTurn) {
    return [
      "[ADE lane]",
      `This chat is an ADE lane. Its branch is \`${branch}\`${repo ? ` in \`${repo}\`` : ""}.`,
      `Before anything else: fetch and check out \`${branch}\` (it exists on origin). Do not create a different branch.`,
      `Commit your work to \`${branch}\` and push it there, so ADE can show it. Open a pull request only if asked.`,
    ].join("\n");
  }
  return `[ADE lane] Stay on branch \`${branch}\`; commit and push work there.`;
}
