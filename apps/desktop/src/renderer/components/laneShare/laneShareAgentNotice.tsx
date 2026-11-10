import { ShareNetwork } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { showToast } from "../app/toast/toastStore";
import { revokeLaneShares } from "./laneShareActions";
import { agentSharesToNotice } from "./laneShareModel";
import { onLaneSharesLoaded, openLaneShareSheet } from "./laneShareStore";

/**
 * The owner's notice for a share an agent made (`createdBy: "agent"`). It
 * runs on every read of a machine's share list: a host event makes the
 * window read the list again, and so does the first read after a start, so
 * one path covers a live share, a reconnect and a share made while the app
 * was closed. A share shows its notice once on this computer: the noticed
 * grant ids and each list's last read time are kept in this viewer's
 * storage, shared by its windows. The "Made by an agent" label in the list
 * stays the durable signal.
 */

const STORAGE_KEY = "ade.laneShare.agentShareNotices.v1";
const MAX_SEEN_GRANTS = 200;
const MAX_LIST_KEYS = 50;

type NoticeRecord = { seen: string[]; lastListAt: Record<string, number> };

function readRecord(): NoticeRecord {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<NoticeRecord> | null;
    const seen = Array.isArray(parsed?.seen) ? parsed.seen.filter((id): id is string => typeof id === "string") : [];
    const lastListAt: Record<string, number> = {};
    if (parsed?.lastListAt && typeof parsed.lastListAt === "object") {
      for (const [key, at] of Object.entries(parsed.lastListAt)) {
        if (typeof at === "number" && Number.isFinite(at)) lastListAt[key] = at;
      }
    }
    return { seen, lastListAt };
  } catch {
    return { seen: [], lastListAt: {} };
  }
}

function writeRecord(record: NoticeRecord): void {
  const keys = Object.entries(record.lastListAt).sort((a, b) => b[1] - a[1]).slice(0, MAX_LIST_KEYS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      seen: record.seen.slice(-MAX_SEEN_GRANTS),
      lastListAt: Object.fromEntries(keys),
    }));
  } catch {
    // No storage (a private window): a notice may show again after a restart.
  }
}

function showAgentShareNotice(share: LaneShareGivenEntry, listKey: string, pin: OpenProjectBinding | null): void {
  const laneName = share.laneLabel?.trim() || share.laneId;
  const receiver = share.receiverEmail ?? "a guest";
  showToast({
    id: `lane-share-agent:${share.grantId}`,
    tone: "info",
    icon: <ShareNetwork size={16} weight="bold" />,
    title: `An agent shared the lane ${laneName} with ${receiver}`,
    message: "Watch only.",
    replayMask: { title: true },
    // Sticky: an agent may share while nobody watches the screen.
    durationMs: 0,
    actions: [
      // The lane machine's pin: the revoke goes to the machine that holds the share.
      { label: "Remove", onClick: () => void revokeLaneShares([share], pin, listKey) },
      {
        label: "View",
        variant: "secondary",
        onClick: () => openLaneShareSheet({
          listKey,
          laneId: share.laneId,
          laneName,
          pin,
          machineName: pin?.kind === "remote" ? pin.runtimeName : null,
          grantId: share.grantId,
        }),
      },
    ],
  });
}

/** One read of a machine's list: shows the new agent-made shares and records the read. */
export function noticeAgentShares(listKey: string, pin: OpenProjectBinding | null, shares: readonly LaneShareGivenEntry[]): void {
  const record = readRecord();
  const fresh = agentSharesToNotice(shares, { grantIds: new Set(record.seen), lastListAt: record.lastListAt[listKey] ?? null });
  writeRecord({
    seen: [...record.seen, ...fresh.map((share) => share.grantId)],
    lastListAt: { ...record.lastListAt, [listKey]: Date.now() },
  });
  for (const share of fresh) showAgentShareNotice(share, listKey, pin);
}

/** Installs the notice for this window. Returns its removal. */
export function installAgentShareNotices(): () => void {
  return onLaneSharesLoaded(noticeAgentShares);
}
