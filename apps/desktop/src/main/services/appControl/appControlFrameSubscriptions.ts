import type { WebContents } from "electron";

/** The lane key of a hold that admits every lane (`holdFrames()` with no lane). */
export const APP_CONTROL_FRAME_ALL_LANES = "*";

/**
 * Which lanes' App Control screencast frames each window is showing.
 *
 * A frame is an 80-350 KB base64 JPEG, sent at the page's repaint rate for
 * every lane with an attached session. Without this gate every window cloned
 * every frame of every lane over IPC, whether or not anything painted it, so
 * an agent driving a dev app in another lane kept this renderer receiving
 * pictures nobody saw. Mirrors `ptyDataSubscriptions`.
 */
const laneIdsByWebContentsId = new Map<number, Set<string>>();
const cleanupRegistered = new Set<number>();
const changeListeners = new Set<() => void>();

const notifyChanged = (): void => {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {}
  }
};

/**
 * Every lane any window holds, or `"all"` when one holds every lane. This is
 * what the screencast follows: a lane no window shows streams no frames.
 */
export function heldAppControlFrameLanes(): string[] | "all" {
  const lanes = new Set<string>();
  for (const held of laneIdsByWebContentsId.values()) {
    for (const laneId of held) {
      if (laneId === APP_CONTROL_FRAME_ALL_LANES) return "all";
      lanes.add(laneId);
    }
  }
  return [...lanes];
}

/** Called after any window's held lanes change, or a window goes away. */
export function onAppControlFrameLanesChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function normalizeAppControlFrameLaneIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id) ids.add(id);
  }
  return ids;
}

export function setAppControlFrameLanesForSender(
  sender: WebContents,
  laneIds: Set<string>,
): void {
  const webContentsId = sender.id;
  laneIdsByWebContentsId.set(webContentsId, laneIds);
  notifyChanged();
  if (cleanupRegistered.has(webContentsId)) return;
  cleanupRegistered.add(webContentsId);
  sender.once("destroyed", () => {
    cleanupRegistered.delete(webContentsId);
    laneIdsByWebContentsId.delete(webContentsId);
    notifyChanged();
  });
}

/**
 * Unlike `pty_data`, the default is closed: every view that paints frames holds
 * its lane first, so a window that never held one has nothing to paint them on.
 */
export function shouldSendAppControlFrameToWebContents(
  sender: WebContents,
  laneId: string | null | undefined,
): boolean {
  const laneIds = laneIdsByWebContentsId.get(sender.id);
  if (!laneIds || laneIds.size === 0) return false;
  if (laneIds.has(APP_CONTROL_FRAME_ALL_LANES)) return true;
  return laneId ? laneIds.has(laneId) : true;
}
