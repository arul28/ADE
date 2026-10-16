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
import type { CloudAgentProvider } from "./types/cloudAgents";

/** The clouds a lane can live on: the same set as the cloud agent providers. */
export type CloudLaneProvider = CloudAgentProvider;

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

