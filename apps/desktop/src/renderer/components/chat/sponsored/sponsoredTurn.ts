import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { CLOUD_SPONSORED_MESSAGE_MAX_CHARS, type CloudSponsoredDevice, type CloudSponsoredMessage } from "../../../../shared/adeCloud";

/** A card is asked for only under a reply this recent: an old chat opened later gets none. */
export const SPONSORED_TURN_FRESH_MS = 24 * 60 * 60_000;

export type SponsoredTurn = {
  turnId: string;
  finishedAt: number;
  /** The person's request and the agent's reply, the only text an ad request sends. */
  messages: CloudSponsoredMessage[];
};

const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > CLOUD_SPONSORED_MESSAGE_MAX_CHARS ? trimmed.slice(-CLOUD_SPONSORED_MESSAGE_MAX_CHARS) : trimmed;
};

/**
 * The chat's last turn when it finished well and nothing came after it: its
 * id, when it ended, and its request and reply. Null while a turn runs, after
 * a failed or stopped turn, or when the person already wrote again.
 */
export function lastFinishedTurn(events: readonly AgentChatEventEnvelope[]): SponsoredTurn | null {
  let doneIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if (event.type === "user_message") return null;
    if (event.type === "done") {
      if (event.status !== "completed") return null;
      doneIndex = index;
      break;
    }
  }
  if (doneIndex < 0) return null;
  const done = events[doneIndex]!;
  const turnId = done.event.type === "done" ? done.event.turnId : "";
  if (!turnId) return null;
  const reply: string[] = [];
  let request = "";
  for (let index = doneIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if (event.type === "user_message") {
      request = event.displayText ?? event.text;
      break;
    }
    if (event.type === "text" && (!event.turnId || event.turnId === turnId)) reply.push(event.text);
  }
  const answer = tail(reply.reverse().join(""));
  const asked = tail(request);
  if (!answer || !asked) return null;
  const finishedAt = Date.parse(done.timestamp);
  return {
    turnId,
    finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0,
    messages: [{ role: "user", content: asked }, { role: "assistant", content: answer }],
  };
}

/** What Gravity needs to know about the screen this card would show on. */
export function sponsoredDevice(): CloudSponsoredDevice {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os: CloudSponsoredDevice["os"] = /iPhone|iPad|iPod/.test(ua)
    ? "ios"
    : /Android/.test(ua)
      ? "android"
      : /CrOS/.test(ua)
        ? "chromeos"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macos"
          : /Windows/.test(ua)
            ? "windows"
            : /Linux/.test(ua)
              ? "linux"
              : "other";
  const type: CloudSponsoredDevice["type"] = /iPad|Tablet/.test(ua) || (os === "android" && !/Mobile/.test(ua))
    ? "tablet"
    : /Mobi|iPhone|iPod/.test(ua)
      ? "mobile"
      : "desktop";
  const version = os === "windows"
    ? /Windows NT ([\d.]+)/.exec(ua)?.[1]
    : os === "macos"
      ? /Mac OS X ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, ".")
      : os === "android"
        ? /Android ([\d.]+)/.exec(ua)?.[1]
        : os === "ios"
          ? /OS ([\d_]+) like Mac OS X/.exec(ua)?.[1]?.replace(/_/g, ".")
          : undefined;
  return { type, os, ...(version ? { osVersion: version } : {}), ...(ua ? { ua: ua.slice(0, 512) } : {}) };
}
