/**
 * Chat titles and lane names for the tabs `ade browser status` lists, so the
 * owner column reads "Checkout flow test" · lane Primary instead of two ids.
 */

/** Titles and names by id; an id this machine does not know is left out. */
export type OwnerNames = { chats: Record<string, string>; lanes: Record<string, string> };

export type DescribeOwners = (ids: { chatSessionIds: string[]; laneIds: string[] }) => Promise<OwnerNames>;

/** How long `ade browser status` waits for owner names before printing ids. */
const OWNER_NAMES_WAIT_MS = 800;

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Put chat titles and lane names beside the ids, so a person and an agent can tell whose a tab is. */
export async function nameTabOwners(
  lists: unknown[][],
  describeOwners: DescribeOwners | null,
  onError?: (error: unknown) => void,
): Promise<void> {
if (!describeOwners) return;
  const tabs = lists.flat().filter(isRecord);
  const chatSessionIds = new Set<string>();
  const laneIds = new Set<string>();
  for (const tab of tabs) {
    const owner = stringOrNull(tab.ownerChatSessionId);
    const opener = stringOrNull(tab.openedByChatSessionId);
    const lane = stringOrNull(tab.ownerLaneId);
    if (owner) chatSessionIds.add(owner);
    if (opener) chatSessionIds.add(opener);
    if (lane) laneIds.add(lane);
  }
  if (chatSessionIds.size === 0 && laneIds.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const names = await Promise.race([
    describeOwners({ chatSessionIds: [...chatSessionIds], laneIds: [...laneIds] }).catch((error: unknown) => {
      // The ids still print; only the names are missing.
      onError?.(error);
      return null;
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), OWNER_NAMES_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!names) return;
  for (const tab of tabs) {
    const owner = stringOrNull(tab.ownerChatSessionId);
    const opener = stringOrNull(tab.openedByChatSessionId);
    const lane = stringOrNull(tab.ownerLaneId);
    if (owner && names.chats[owner]) tab.ownerChatTitle = names.chats[owner];
    if (opener && names.chats[opener]) tab.openedByChatTitle = names.chats[opener];
    if (lane && names.lanes[lane]) tab.ownerLaneName = names.lanes[lane];
  }
}
