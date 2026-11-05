import {
  ANDROID_AGENT_ACTIONS,
  ANDROID_SDK_PERSON_ONLY_ACTIONS,
  ANDROID_USER_ONLY_ACTIONS,
  type AndroidEmulatorEvent,
  type AndroidLaneDeviceStatus,
  type AndroidStreamStatus,
} from "../../../shared/types/androidEmulator";
import {
  createStreamTicketBook,
  resolveAppleStreamUrl,
  unavailable,
  withStreamTicketToken,
  type StreamTicket,
} from "./streamTicket";
import type { AdeNamespace } from "./types";

/**
 * The `androidEmulator` namespace for the hosted web client.
 *
 * The web client renders the SAME Android pane as the desktop, so every call
 * becomes an `android.*` sync command on the machine that runs the emulator.
 * The pattern of `appleDevice.ts`:
 *
 * - **The picture is a relay WebSocket.** `startStream` mints a single-use
 *   ticket (`android.streamTicket`) in place of the loopback address, and
 *   `resolveStreamUrl` turns its path into a `ws(s)://` URL on this tab's
 *   connection. The relay stops the stream when the last remote viewer
 *   leaves, so `stopStream` here has nothing to send.
 * - **The finger is one command.** `sendTouch`, keys and text go through
 *   `android.input`, which the host allows to a controller (the owner's phone
 *   or web tab), never to a desktop pairing at viewer role.
 * - **The rest is the allowlisted passthrough** (`android.invoke`), the same
 *   allowlist as the `android_emulator` action domain.
 * - **No SDK install from a browser.** Google's licences are accepted on the
 *   machine itself, so the setup writes refuse here with a plain message.
 * - **Events come from a status read.** The brain's Android events are not on
 *   the sync bus. While the pane listens and the tab is visible, the lanes it
 *   read most recently are re-read every few seconds, and a changed state (or
 *   a new app crash) becomes the `android.device.state` event the pane already
 *   handles: it reads the full status again.
 */

/** How often a listening, visible tab re-reads its lanes' state. */
export const ANDROID_WEB_STATE_POLL_MS = 3_000;
/**
 * The lanes a tab keeps re-reading, newest first: the lane on screen and a few
 * the person just left. A lane read again moves to the front, so a long visit
 * across many lanes does not add a status read per lane to every tick.
 */
const ANDROID_WEB_POLLED_LANES_MAX = 4;

type AndroidCall = <T>(
  action: string,
  args: unknown,
  fallback: T | (() => T | Promise<T>),
  idempotent?: boolean,
) => Promise<T>;

type AndroidMethod = (args?: unknown, pin?: unknown) => Promise<unknown>;

const NO_HOST = "The Android emulator isn't available on the connected ADE host.";
const SETUP_ON_MACHINE = "Set up Android in the ADE desktop app on that computer.";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reads that a retry may repeat without a second effect. */
function isRead(method: string): boolean {
  return /^(get|list|find|read|assert|wait)/.test(method) || method === "screenshot" || method === "deviceLeaseStatus";
}

export function createAndroidDeviceNamespace(
  call: AndroidCall,
  getEndpoint: () => string | null,
): AdeNamespace<"androidEmulator"> {
  /** The tickets this tab was handed, so `resolveStreamUrl` finds the one behind each URL. */
  const tickets = createStreamTicketBook();
  /** The lanes the pane read most recently (oldest first), with the state and app crash each last showed. */
  const laneStates = new Map<string, { state: AndroidLaneDeviceStatus["state"] | null; crashId: string | null }>();
  const listeners = new Set<(event: AndroidEmulatorEvent) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const noteLaneState = (laneId: string, state: unknown, crashId: string | null = null): void => {
    const next = (typeof state === "string" ? state : null) as AndroidLaneDeviceStatus["state"] | null;
    const previous = laneStates.get(laneId);
    // Only `getStatus` adds a lane: a poll that ends after the lane left the set does not bring it back.
    if (!previous) return;
    laneStates.set(laneId, { state: next, crashId });
    if (next === null || (previous.state === next && previous.crashId === crashId)) return;
    const event: AndroidEmulatorEvent = { type: "android.device.state", laneId, state: next };
    for (const listener of listeners) listener(event);
  };

  const pollLanes = async (): Promise<void> => {
    if (polling || listeners.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    polling = true;
    try {
      for (const laneId of [...laneStates.keys()]) {
        const status = record(await call("android.status", { laneId }, null, true).catch(() => null));
        const device = record(status.device);
        if (status.laneId === laneId) noteLaneState(laneId, device.state ?? "none", text(record(status.appCrash).id));
      }
    } finally {
      polling = false;
    }
  };

  const invoke = (method: string, args: unknown): Promise<unknown> => {
    const source = record(args);
    return call(
      "android.invoke",
      { method, laneId: text(source.laneId), chatSessionId: text(source.chatSessionId), args: source },
      unavailable(NO_HOST),
      isRead(method),
    );
  };

  const input = (kind: string, args: unknown, extra: Record<string, unknown>): Promise<unknown> => call(
    "android.input",
    { kind, laneId: text(record(args).laneId), ...extra },
    unavailable(NO_HOST),
    false,
  );

  const namespace: Record<string, unknown> = {};
  for (const method of new Set<string>([...ANDROID_AGENT_ACTIONS, ...ANDROID_USER_ONLY_ACTIONS])) {
    namespace[method] = ((args?: unknown) => invoke(method, args)) satisfies AndroidMethod;
  }
  for (const method of ANDROID_SDK_PERSON_ONLY_ACTIONS) {
    namespace[method] = (async () => {
      throw new Error(SETUP_ON_MACHINE);
    }) satisfies AndroidMethod;
  }

  const overrides: Record<string, AndroidMethod> = {
    async getStatus(args) {
      const laneId = text(record(args).laneId);
      if (!laneId) return invoke("getStatus", args);
      const status = record(await call("android.status", { laneId, full: true }, unavailable(NO_HOST), true));
      // Remembered without an event: the pane asked, so it already knows.
      laneStates.delete(laneId);
      laneStates.set(laneId, {
        state: (text(record(status.device).state) ?? "none") as AndroidLaneDeviceStatus["state"],
        crashId: text(record(status.appCrash).id),
      });
      for (const oldest of laneStates.keys()) {
        if (laneStates.size <= ANDROID_WEB_POLLED_LANES_MAX) break;
        laneStates.delete(oldest);
      }
      return status.raw ?? status;
    },
    listDevices: (args) => call("android.deviceList", { laneId: text(record(args).laneId) }, unavailable(NO_HOST), true),
    async startStream(args): Promise<AndroidStreamStatus> {
      const source = record(args);
      const laneId = text(source.laneId);
      if (!laneId) throw new Error("The Android live view needs a lane on the web client.");
      const ticket = await call<StreamTicket>(
        "android.streamTicket",
        { laneId, chatSessionId: text(source.chatSessionId) },
        unavailable(NO_HOST),
        false,
      );
      tickets.add(laneId, ticket);
      return {
        laneId,
        running: true,
        backend: "scrcpy",
        fps: null,
        transport: {
          url: ticket.url ?? ticket.path,
          token: ticket.token,
          codec: ticket.codec ?? "h264",
          width: ticket.width ?? 0,
          height: ticket.height ?? 0,
        },
      };
    },
    // The relay stops the stream when this tab's socket closes.
    async stopStream(args): Promise<AndroidStreamStatus> {
      tickets.forgetLane(text(record(args).laneId));
      return { laneId: text(record(args).laneId) ?? "", running: false, backend: null, transport: null, fps: null };
    },
    sendTouch: (args) => input("touch", args, { events: record(args).events }),
    sendKey: (args) => input("key", args, { key: record(args).key }),
    sendText: (args) => input("type", args, { text: record(args).text }),
    tap: (args) => input("tap", args, { x: record(args).x, y: record(args).y }),
    swipe: (args) => input("swipe", args, record(args)),
    recordList: (args) => call("android.recordList", { laneId: text(record(args).laneId) }, unavailable(NO_HOST), true),
    recordStart: (args) => call("android.recordStart", record(args), unavailable(NO_HOST), false),
    recordStop: (args) => call("android.recordStop", record(args), unavailable(NO_HOST), false),
  };

  return {
    ...namespace,
    ...overrides,
    resolveStreamUrl: async (streamUrl: string | null) => {
      const ticket = tickets.find(streamUrl);
      const ticketPath = ticket?.path ?? (typeof streamUrl === "string" ? streamUrl : "");
      return withStreamTicketToken(resolveAppleStreamUrl(getEndpoint(), ticketPath), ticket);
    },
    onEvent: (listener: (event: AndroidEmulatorEvent) => void) => {
      listeners.add(listener);
      pollTimer ??= setInterval(() => void pollLanes(), ANDROID_WEB_STATE_POLL_MS);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !pollTimer) return;
        clearInterval(pollTimer);
        pollTimer = null;
      };
    },
  } as unknown as AdeNamespace<"androidEmulator">;
}
