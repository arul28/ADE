import type { OpenProjectBinding } from "../../shared/types/core";
import { useAppStore } from "../state/appStore";
import { effectiveRuntimeBinding } from "./chatMachineRouting";

/**
 * Read a chat attachment image as a data URL on the machine that owns it.
 *
 * One rule for every surface that shows or copies an attachment image:
 * - Read through the runtime of `pin`. No pin means the machine this window is
 *   bound to.
 * - Fall back to this computer's own reader only when the owner is this
 *   computer: a local pin, or no pin in a window bound to a local project (or
 *   to no project).
 * - Never read a remote-owned path here. That path names a file on the other
 *   machine, and on this computer it is missing or, worse, a different file.
 */
export async function readAttachmentImageDataUrl(
  path: string,
  pin: OpenProjectBinding | null | undefined,
): Promise<{ dataUrl: string }> {
  const owner = effectiveRuntimeBinding(pin, useAppStore.getState().projectBinding);
  const ownedHere = owner?.kind !== "remote";
  const runtimeRead = window.ade?.agentChat?.getImageDataUrl;
  const localRead = window.ade?.app?.getImageDataUrl;
  if (!runtimeRead) {
    if (ownedHere && localRead) return await localRead(path);
    throw new Error("No image reader is available for the machine that owns this attachment.");
  }
  try {
    return await runtimeRead(path, pin ?? undefined);
  } catch (error) {
    if (!ownedHere || !localRead) throw error;
    return await localRead(path);
  }
}
