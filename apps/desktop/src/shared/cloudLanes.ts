import type { AgentChatDevinCloudConfig } from "./types/chat";

/**
 * Cloud lanes.
 *
 * A cloud lane is a lane whose work happens on a provider's VM — Devin Cloud or
 * Cursor Cloud — rather than on an ADE machine. ADE still keeps a worktree for
 * it, but that worktree is a read-only mirror of the lane branch: the branch is
 * the lane, and the branch's author is the cloud agent. So the lane shows the
 * cloud as its machine, every chat in it is that provider's cloud agent, and
 * the terminal opens on the VM (`devin ssh`) where there is one.
 *
 * The marker is a reserved lane tag rather than a new column: `tags` already
 * rides the synced `lanes` row to every client, including the phone.
 */
export type CloudLaneProvider = "devin" | "cursor";

export const CLOUD_LANE_TAG_PREFIX = "ade:cloud:";

export const CLOUD_LANE_LABELS: Record<CloudLaneProvider, string> = {
  devin: "Devin Cloud",
  cursor: "Cursor Cloud",
};

export function cloudLaneTag(provider: CloudLaneProvider): string {
  return `${CLOUD_LANE_TAG_PREFIX}${provider}`;
}

/** Reserved tags ADE owns. Tag editors hide them. */
export function isReservedLaneTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(CLOUD_LANE_TAG_PREFIX);
}

export function laneCloudProvider(lane: { tags?: readonly string[] | null } | null | undefined): CloudLaneProvider | null {
  for (const tag of lane?.tags ?? []) {
    const value = tag.trim().toLowerCase();
    if (value === cloudLaneTag("devin")) return "devin";
    if (value === cloudLaneTag("cursor")) return "cursor";
  }
  return null;
}

/** `tags` with exactly one cloud marker (or none when `provider` is null). */
export function withCloudLaneTag(tags: readonly string[] | null | undefined, provider: CloudLaneProvider | null): string[] {
  const kept = (tags ?? []).filter((tag) => !isReservedLaneTag(tag));
  return provider ? [...kept, cloudLaneTag(provider)] : kept;
}

// ---------------------------------------------------------------------------
// Devin Cloud (ACP relay)
// ---------------------------------------------------------------------------

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
