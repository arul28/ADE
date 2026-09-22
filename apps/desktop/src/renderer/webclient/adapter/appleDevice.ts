import type { AdeSyncClient } from "../sync";
import type { AdeNamespace } from "./types";

/**
 * The `iosSimulator` namespace for the hosted web client.
 *
 * The web client renders the SAME Apple column as the desktop, so this is a
 * real adapter rather than the `createNativeUnavailableNamespace()` stub it
 * replaces. Every call becomes an `apple.*` sync command on the machine that
 * owns the device; nothing here runs locally, because nothing can.
 *
 * Two things are genuinely different from the desktop:
 *
 * 1. **The stream is a WebSocket, not a loopback body.** `startStream` mints a
 *    ticket instead of returning the helper's address, and `resolveStreamUrl`
 *    turns that ticket's path into an absolute `ws(s)://` URL against whatever
 *    endpoint this tab is connected through. `IosSimH264Video` reads either.
 * 2. **The relay needs to be told the local path.** A direct endpoint resolves
 *    by URL arithmetic. A relay endpoint (`/connect/<machineKey>`) pairs the
 *    tab with a brain-side pipe that dials loopback itself, so the ticket path
 *    rides as the `apple-stream` pipe kind and the brain validates it before
 *    dialing.
 */

export const APPLE_STREAM_PIPE_KIND = "apple-stream";

type AppleCall = <T>(
  action: string,
  args: unknown,
  fallback: T | (() => T | Promise<T>),
  idempotent?: boolean,
) => Promise<T>;

type AppleStreamTicketResult = {
  url: string | null;
  path: string;
  token: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  expiresAt: string;
};

function unavailable(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

const NO_HOST = "The Apple device environment isn't available on the connected ADE host.";

/**
 * Absolute stream URL for this tab's route.
 *
 * Exported and pure so the relay branch — the one a test can never reach by
 * standing up a real tunnel — is covered by a unit test rather than by hope.
 */
export function resolveAppleStreamUrl(
  endpoint: string | null,
  ticketPath: string,
): { url: string | null; forwarded: boolean; error: string | null } {
  if (!ticketPath) {
    return { url: null, forwarded: false, error: "The live view returned no address." };
  }
  if (!endpoint) {
    return {
      url: null,
      forwarded: false,
      error: "The live view needs a connection to the ADE machine that owns the device.",
    };
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return { url: null, forwarded: false, error: "The ADE connection has no usable address." };
  }
  // A relay endpoint pairs this tab with a brain-side pipe socket; the pipe,
  // not the tab, decides which local path to dial, so the path rides as a
  // parameter instead of being appended to the relay's own URL.
  if (/\/connect\/[^/]+$/.test(base.pathname)) {
    const relay = new URL(base.toString());
    relay.searchParams.set("kind", APPLE_STREAM_PIPE_KIND);
    relay.searchParams.set("path", ticketPath);
    return { url: relay.toString(), forwarded: true, error: null };
  }
  const [path, query] = ticketPath.split("?");
  const direct = new URL(path ?? "", base);
  direct.search = query ? `?${query}` : "";
  return { url: direct.toString(), forwarded: false, error: null };
}

export function createAppleDeviceNamespace(
  call: AppleCall,
  getEndpoint: () => string | null,
): AdeNamespace<"iosSimulator"> {
  /** The most recent ticket, so `resolveStreamUrl` can find its path again. */
  let lastTicket: AppleStreamTicketResult | null = null;

  const laneOf = (args: unknown): string | null => {
    const record = (args ?? {}) as { laneId?: unknown };
    return typeof record.laneId === "string" && record.laneId.trim() ? record.laneId.trim() : null;
  };
  const chatOf = (args: unknown): string | null => {
    const record = (args ?? {}) as { chatSessionId?: unknown };
    return typeof record.chatSessionId === "string" && record.chatSessionId.trim()
      ? record.chatSessionId.trim()
      : null;
  };

  /** Anything not named on the wire goes through the allowlisted passthrough. */
  const invoke = <T>(method: string, args: unknown, idempotent: boolean): Promise<T> => call<T>(
    "apple.invoke",
    { method, laneId: laneOf(args), chatSessionId: chatOf(args), args: args ?? {} },
    unavailable(NO_HOST),
    idempotent,
  );

  return {
    getStatus: (async (...callArgs: unknown[]) => {
      // The desktop signature is `(pin)`; the lane rides the pin on that side
      // and the args record on this one, so accept either shape.
      const args = (callArgs[0] ?? {}) as { laneId?: unknown };
      const laneId = laneOf(args);
      if (!laneId) return invoke("getStatus", args, true);
      const status = await call<{ raw?: unknown }>(
        "apple.status",
        { laneId, full: true },
        unavailable(NO_HOST),
        true,
      );
      return status.raw ?? status;
    }) as never,

    startStream: (async (args?: unknown) => {
      const laneId = laneOf(args);
      if (!laneId) throw new Error("The Apple live view needs a lane on the web client.");
      const ticket = await call<AppleStreamTicketResult>(
        "apple.streamTicket",
        { laneId, chatSessionId: chatOf(args) },
        unavailable(NO_HOST),
        false,
      );
      lastTicket = ticket;
      return {
        running: true,
        deviceUdid: null,
        backend: "helper-h264",
        streamUrl: ticket.url ?? ticket.path,
        transport: {
          url: ticket.url ?? ticket.path,
          port: 0,
          token: ticket.token,
          codec: ticket.codec,
          width: ticket.width,
          height: ticket.height,
        },
      };
    }) as never,

    // `(pin, args)` on the desktop; only the args matter here.
    stopStream: (async (_pin?: unknown, args?: unknown) => {
      lastTicket = null;
      return invoke("stopStream", args ?? {}, false);
    }) as never,
    getStreamStatus: (async (_pin?: unknown, args?: unknown) =>
      invoke("getStreamStatus", args ?? {}, true)) as never,

    resolveStreamUrl: (async (streamUrl: string | null) => {
      const ticketPath = lastTicket?.path
        ?? (typeof streamUrl === "string" ? streamUrl : "");
      const resolved = resolveAppleStreamUrl(getEndpoint(), ticketPath);
      if (!resolved.url || !lastTicket) return resolved;
      // The token cannot ride a WebSocket header from a browser, so it rides
      // the query the brain also accepts. `IosSimH264Video` still passes the
      // token separately for the loopback transport; this is the other one.
      const withToken = new URL(resolved.url);
      if (!withToken.searchParams.get("kind")) {
        withToken.searchParams.set("token", lastTicket.token);
      } else {
        withToken.searchParams.set("path", `${lastTicket.path}?token=${lastTicket.token}`);
      }
      return { ...resolved, url: withToken.toString() };
    }) as never,

    deviceList: (async (args?: unknown) => call(
      "apple.deviceList",
      {
        laneId: laneOf(args),
        installed: true,
        // The picker's second, disk-only read has to reach the host too, or the
        // web client's inventory line is the one surface with no disk number.
        disk: (args as { disk?: unknown } | null | undefined)?.disk === true,
      },
      unavailable(NO_HOST),
      true,
    )) as never,
    deviceCreate: (async (args?: unknown) => call(
      "apple.deviceCreate",
      { laneId: laneOf(args), ...(args ?? {}) },
      unavailable(NO_HOST),
      false,
    )) as never,
    deviceAttach: (async (args?: unknown) => call(
      "apple.deviceAttach",
      { laneId: laneOf(args), ...(args ?? {}) },
      unavailable(NO_HOST),
      false,
    )) as never,
    // Through the allowlisted passthrough rather than new wire actions: the
    // boot and the power-off are mutations on the owning machine, and
    // `apple.invoke` already carries the cooperative-ownership guard every
    // other mutation gets.
    deviceStart: (async (args?: unknown) => invoke("deviceStart", args ?? {}, false)) as never,
    deviceStop: (async (args?: unknown) => invoke("deviceStop", args ?? {}, false)) as never,
    deviceDelete: (async (args?: unknown) => invoke("deviceDelete", args ?? {}, false)) as never,

    recordList: (async (args?: unknown) => call(
      "apple.recordList",
      { laneId: laneOf(args) },
      unavailable(NO_HOST),
      true,
    )) as never,
    recordStart: (async (args?: unknown) => call(
      "apple.recordStart",
      { laneId: laneOf(args), chatSessionId: chatOf(args), ...(args ?? {}) },
      unavailable(NO_HOST),
      false,
    )) as never,
    recordStop: (async (args?: unknown) => call(
      "apple.recordStop",
      { laneId: laneOf(args), chatSessionId: chatOf(args), ...(args ?? {}) },
      unavailable(NO_HOST),
      false,
    )) as never,
    recordDelete: (async (args?: unknown) => invoke("recordDelete", args ?? {}, false)) as never,

    /* Input. One action on the wire, in DEVICE POINTS, ownership-guarded. */
    tap: (async (args: { x: number; y: number }) => call(
      "apple.input",
      { kind: "tap", laneId: laneOf(args), chatSessionId: chatOf(args), x: args.x, y: args.y },
      unavailable(NO_HOST),
      false,
    )) as never,
    typeText: (async (args: { text: string }) => call(
      "apple.input",
      { kind: "type", laneId: laneOf(args), chatSessionId: chatOf(args), text: args.text },
      unavailable(NO_HOST),
      false,
    )) as never,
    drag: (async (args: Record<string, unknown>) => call(
      "apple.input",
      { kind: "drag", laneId: laneOf(args), chatSessionId: chatOf(args), ...args },
      unavailable(NO_HOST),
      false,
    )) as never,
    swipe: (async (args: Record<string, unknown>) => call(
      "apple.input",
      { kind: "drag", laneId: laneOf(args), chatSessionId: chatOf(args), ...args },
      unavailable(NO_HOST),
      false,
    )) as never,
    scroll: (async (args: Record<string, unknown>) => call(
      "apple.input",
      { kind: "scroll", laneId: laneOf(args), chatSessionId: chatOf(args), ...args },
      unavailable(NO_HOST),
      false,
    )) as never,
    tapElement: (async (args: Record<string, unknown>) => call(
      "apple.input",
      { kind: "tap-element", laneId: laneOf(args), chatSessionId: chatOf(args), ...args },
      unavailable(NO_HOST),
      false,
    )) as never,
    openUrl: (async (args: { url: string }) => call(
      "apple.input",
      { kind: "open-url", laneId: laneOf(args), chatSessionId: chatOf(args), url: args.url },
      unavailable(NO_HOST),
      false,
    )) as never,

    /* Everything else the pane reaches for, behind the host's allowlist. */
    launch: (async (args?: unknown) => invoke("launch", args ?? {}, false)) as never,
    attachToChatSession: (async (args?: unknown) => invoke("attachToChatSession", args ?? {}, false)) as never,
    shutdown: (async (args?: unknown) => invoke("shutdown", args ?? {}, false)) as never,
    openDevice: (async (args?: unknown) => invoke("openDevice", args ?? {}, false)) as never,
    closeDevice: (async (args?: unknown) => invoke("closeDevice", args ?? {}, false)) as never,
    screenshot: (async (args?: unknown) => invoke("screenshot", args ?? {}, true)) as never,
    getScreenSnapshot: (async (args?: unknown) => invoke("getScreenSnapshot", args ?? {}, true)) as never,
    getInspectorSnapshot: (async (args?: unknown) => invoke("getInspectorSnapshot", args ?? {}, true)) as never,
    inspectPoint: (async (args?: unknown) => invoke("inspectPoint", args ?? {}, true)) as never,
    captureProofBundle: (async (args?: unknown) => invoke("captureProofBundle", args ?? {}, false)) as never,
    listDevices: (async () => invoke("listDevices", {}, true)) as never,
    listLaunchTargets: (async (args?: unknown) => invoke("listLaunchTargets", args ?? {}, true)) as never,
    getDeviceSession: (async (args?: unknown) => invoke("getDeviceSession", args ?? {}, true)) as never,
    getDeviceSettings: (async (args?: unknown) => invoke("getDeviceSettings", args ?? {}, true)) as never,
    getForegroundApp: (async (args?: unknown) => invoke("getForegroundApp", args ?? {}, true)) as never,
    setAppearance: (async (args?: unknown) => invoke("setAppearance", args ?? {}, false)) as never,
    setContentSize: (async (args?: unknown) => invoke("setContentSize", args ?? {}, false)) as never,
    relaunchApp: (async (args?: unknown) => invoke("relaunchApp", args ?? {}, false)) as never,
    terminateApp: (async (args?: unknown) => invoke("terminateApp", args ?? {}, false)) as never,
    // The rail's Home/volume/Siri and its orientation control. Absent before
    // round 5, so a web tab rendered both and neither did anything.
    pressButton: (async (args?: unknown) => invoke("pressButton", args ?? {}, false)) as never,
    rotate: (async (args?: unknown) => invoke("rotate", args ?? {}, false)) as never,
    frame: (async (args?: unknown) => invoke("frame", args ?? {}, false)) as never,

    // Apple device events are not on the sync event bus yet; the pane polls
    // status, so an inert unsubscribe is the honest answer rather than a
    // listener that can never fire.
    onEvent: (() => () => {}) as never,
  } as AdeNamespace<"iosSimulator">;
}

export function appleEndpointReader(client: AdeSyncClient): () => string | null {
  return () => {
    try {
      return client.getStatus().endpoint ?? null;
    } catch {
      return null;
    }
  };
}
