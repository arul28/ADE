import { randomUUID } from "node:crypto";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  isWorkToolShowSurface,
  WORK_TOOL_SHOW_REQUEST_EVENT,
  WORK_TOOL_SHOW_SURFACES,
  type WorkToolShowRequest,
  type WorkToolShowResult,
  type WorkToolShowStatus,
  type WorkToolShowSurface,
} from "../../../../desktop/src/shared/types/workToolShow";

/**
 * `ade ui show` on the brain side.
 *
 * The surfaces an agent wants the user to see (the Apple tool, the floating
 * device, the browser, the proof drawer, the Mac Desktop and App Control tools
 * and their floating cards) are renderer UI, and the brain cannot tell which renderer is showing
 * which chat. So it asks all of them: the request goes out on the runtime event stream every desktop on this project
 * already reads — a local window and a paired desktop on another machine alike
 * — and the one that has the chat answers.
 *
 * The answer is the whole point. An agent that is told "shown" when nothing
 * appeared stops trying and tells the user something false, so no answer
 * within the window means `no_desktop`, never a guess.
 */

/**
 * Long enough for a paired desktop on its idle poll (5s) to hear the request
 * and answer; the local poll is under a second. Only the no-desktop case waits
 * the whole of it.
 */
export const WORK_TOOL_SHOW_ACK_TIMEOUT_MS = 8_000;

/**
 * A `held` answer means one window has the project but not the chat. A second
 * window may have the chat in front, so a held answer waits this long for a
 * `shown` before it is the result.
 */
export const WORK_TOOL_SHOW_HELD_GRACE_MS = 600;

/**
 * One automatic float offer per chat and device in this window. An agent taps
 * many times a second; the renderer only needs to hear "an agent is driving the
 * device" again after it had a chance to change its mind.
 */
export const WORK_TOOL_AGENT_ACTIVITY_THROTTLE_MS = 5_000;

const WORK_TOOL_SHOW_SURFACE_LABELS: Record<WorkToolShowSurface, string> = {
  apple: "Apple device in the tools pane",
  "floating-apple": "floating Apple device",
  browser: "browser in the tools pane",
  proof: "proof drawer",
  "mac-desktop": "Mac Desktop in the tools pane",
  "floating-mac-desktop": "floating Mac Desktop",
  "app-control": "App Control in the tools pane",
  "floating-app-control": "floating App Control",
};

type HeldAnswer = { desktopLabel: string | null; opened: boolean };

/** The sentence the CLI prints, one per outcome. */
function describeWorkToolShowResult(
  status: WorkToolShowStatus,
  surface: WorkToolShowSurface,
  desktopLabel: string | null,
  opened = false,
): string {
  const name = WORK_TOOL_SHOW_SURFACE_LABELS[surface];
  const where = desktopLabel ? ` on ${desktopLabel}` : "";
  if (status === "shown") return `Showing the ${name}${where}.`;
  if (status === "held" && opened) {
    return `Opened the ${name}${where}, but the window is not in front, so the user may not see it yet.`;
  }
  if (status === "held") {
    return `A desktop window${where} has this project open, but the user cannot see this chat right now (another chat is in front, or the window is hidden). The ${name} opens when they go to this chat.`;
  }
  return `No desktop window is open for this chat, so nothing was shown. Tell the user to open this chat in ADE Desktop.`;
}

type PendingShow = {
  request: WorkToolShowRequest;
  held: HeldAnswer | null;
  heldTimer: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: WorkToolShowResult) => void;
};

/** The chat an agent drove a device or lane display from, and its lane. */
export type AgentDeviceActivity = { chatSessionId: string | null; laneId: string | null };

export type WorkToolShowRequests = {
  show(input: unknown): Promise<WorkToolShowResult>;
  acknowledgeShow(input: unknown): { ok: boolean };
  /**
   * An agent just drove this chat's Apple device. Publishes an `auto`
   * floating-player offer, throttled per chat. Never acked and never waited on.
   */
  noteAgentAppleActivity(input: AgentDeviceActivity): boolean;
  /** The same for the lane's Mac Desktop: an `auto` floating-card offer. */
  noteAgentMacDesktopActivity(input: AgentDeviceActivity): boolean;
  /** The same for the lane's App Control app: an `auto` floating-card offer. */
  noteAgentAppControlActivity(input: AgentDeviceActivity): boolean;
  dispose(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function createWorkToolShowRequests(args: {
  emitEvent: (payload: Record<string, unknown>) => void;
  logger?: Logger | null;
  ackTimeoutMs?: number;
  heldGraceMs?: number;
  activityThrottleMs?: number;
  now?: () => number;
}): WorkToolShowRequests {
  const ackTimeoutMs = args.ackTimeoutMs ?? WORK_TOOL_SHOW_ACK_TIMEOUT_MS;
  const heldGraceMs = args.heldGraceMs ?? WORK_TOOL_SHOW_HELD_GRACE_MS;
  const activityThrottleMs = args.activityThrottleMs ?? WORK_TOOL_AGENT_ACTIVITY_THROTTLE_MS;
  const now = args.now ?? Date.now;
  const pending = new Map<string, PendingShow>();
  const lastActivityByChat = new Map<string, number>();
  let disposed = false;

  const buildRequest = (
    surface: WorkToolShowSurface,
    chatSessionId: string,
    laneId: string | null,
    auto: boolean,
  ): WorkToolShowRequest => ({
    requestId: `wts-${randomUUID()}`,
    surface,
    chatSessionId,
    laneId,
    auto,
    requestedAt: new Date(now()).toISOString(),
  });

  const publish = (request: WorkToolShowRequest): boolean => {
    try {
      args.emitEvent({ type: WORK_TOOL_SHOW_REQUEST_EVENT, event: request });
      return true;
    } catch (error) {
      args.logger?.warn("work_tools.show_emit_failed", {
        requestId: request.requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const finish = (
    requestId: string,
    status: WorkToolShowStatus,
    desktopLabel: string | null,
    opened = false,
  ): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.heldTimer) clearTimeout(entry.heldTimer);
    const { request } = entry;
    args.logger?.info("work_tools.show_settled", {
      requestId,
      surface: request.surface,
      chatSessionId: request.chatSessionId,
      status,
    });
    entry.resolve({
      status,
      surface: request.surface,
      chatSessionId: request.chatSessionId,
      requestId,
      desktopLabel,
      message: describeWorkToolShowResult(status, request.surface, desktopLabel, opened),
    });
    return true;
  };

  const noteAgentActivity = (
    surface: "floating-apple" | "floating-mac-desktop" | "floating-app-control",
    input: AgentDeviceActivity,
  ): boolean => {
    const chatSessionId = trimmedOrNull(input.chatSessionId);
    if (!chatSessionId || disposed) return false;
    const key = `${surface}\u0000${chatSessionId}`;
    const at = now();
    const last = lastActivityByChat.get(key);
    if (last != null && at - last < activityThrottleMs) return false;
    lastActivityByChat.delete(key);
    lastActivityByChat.set(key, at);
    // A long-lived brain sees many chats; keep only the recent ones.
    if (lastActivityByChat.size > 256) {
      const oldest = lastActivityByChat.keys().next().value;
      if (oldest) lastActivityByChat.delete(oldest);
    }
    return publish(buildRequest(surface, chatSessionId, trimmedOrNull(input.laneId), true));
  };

  return {
    async show(input) {
      const record = isRecord(input) ? input : {};
      const surface = record.surface;
      if (!isWorkToolShowSurface(surface)) {
        throw new Error(
          `work_tools.show needs a surface: ${WORK_TOOL_SHOW_SURFACES.join(", ")} (got "${String(surface)}").`,
        );
      }
      const chatSessionId = trimmedOrNull(record.chatSessionId);
      if (!chatSessionId) {
        throw new Error("work_tools.show needs the chat to show it in. Run it from the chat, or pass --session <id>.");
      }
      if (disposed) throw new Error("work_tools.show is not available while this runtime shuts down.");
      const request = buildRequest(surface, chatSessionId, trimmedOrNull(record.laneId), false);
      return await new Promise<WorkToolShowResult>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pending.get(request.requestId);
          if (!entry) return;
          // A window that holds the request is a real answer even when the
          // grace for a better one has not run out.
          if (entry.held) finish(request.requestId, "held", entry.held.desktopLabel, entry.held.opened);
          else finish(request.requestId, "no_desktop", null);
        }, ackTimeoutMs);
        timer.unref?.();
        pending.set(request.requestId, { request, held: null, heldTimer: null, timer, resolve });
        if (!publish(request)) finish(request.requestId, "no_desktop", null);
      });
    },

    acknowledgeShow(input) {
      const record = isRecord(input) ? input : {};
      const requestId = trimmedOrNull(record.requestId);
      if (!requestId) return { ok: false };
      const entry = pending.get(requestId);
      if (!entry) return { ok: false };
      const desktopLabel = trimmedOrNull(record.desktopLabel);
      if (record.status === "shown") return { ok: finish(requestId, "shown", desktopLabel) };
      if (record.status !== "held") return { ok: false };
      const opened = record.opened === true;
      if (!entry.held) {
        const held: HeldAnswer = { desktopLabel, opened };
        entry.held = held;
        const heldTimer = setTimeout(() => finish(requestId, "held", held.desktopLabel, held.opened), heldGraceMs);
        heldTimer.unref?.();
        entry.heldTimer = heldTimer;
      } else if (opened && !entry.held.opened) {
        // The window that did open the tool outranks one that only held it.
        entry.held.opened = true;
        entry.held.desktopLabel = desktopLabel;
      }
      return { ok: true };
    },

    noteAgentAppleActivity(input) {
      return noteAgentActivity("floating-apple", input);
    },

    noteAgentMacDesktopActivity(input) {
      return noteAgentActivity("floating-mac-desktop", input);
    },

    noteAgentAppControlActivity(input) {
      return noteAgentActivity("floating-app-control", input);
    },

    dispose() {
      disposed = true;
      for (const requestId of [...pending.keys()]) finish(requestId, "no_desktop", null);
      lastActivityByChat.clear();
    },
  };
}
