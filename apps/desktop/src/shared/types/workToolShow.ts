/**
 * "Show this to the user" — an agent asking the desktop to put a surface of
 * its own chat on screen.
 *
 * An agent can drive a simulator, a browser or a recorder, but everything it
 * produces lives in panes only a desktop renderer can open. Before this there
 * was no way to say "look at this": `apple launch --open-drawer` only worked
 * for a buildable app, and nothing at all opened the proof drawer or the
 * floating device.
 *
 * The brain publishes a request on the runtime event stream every desktop on
 * this project already reads (local or paired over the network), the renderer
 * showing that chat opens the surface and acks, and the CLI prints what really
 * happened. No ack means no desktop has this chat open, and the CLI says so.
 */

export const WORK_TOOL_SHOW_SURFACES = [
  /** The chat's Apple Development tool in the Work tools pane. */
  "apple",
  /** The floating device player over the chat. */
  "floating-apple",
  /** The Browser tool in the Work tools pane. */
  "browser",
  /** The chat's proof drawer. */
  "proof",
] as const;

export type WorkToolShowSurface = (typeof WORK_TOOL_SHOW_SURFACES)[number];

export function isWorkToolShowSurface(value: unknown): value is WorkToolShowSurface {
  return typeof value === "string" && (WORK_TOOL_SHOW_SURFACES as readonly string[]).includes(value);
}

export const WORK_TOOL_SHOW_REQUEST_EVENT = "work_tool_show_request" as const;

/** Published by the brain; read by every desktop renderer on this project. */
export type WorkToolShowRequest = {
  requestId: string;
  surface: WorkToolShowSurface;
  chatSessionId: string;
  laneId: string | null;
  /**
   * True when nobody asked: an agent drove the chat's Apple device and the
   * floating player may come up by itself. An auto request is never acked or
   * held, and the per-chat "Show preview when minimized" choice can refuse it.
   */
  auto: boolean;
  requestedAt: string;
};

export type WorkToolShowRequestEvent = {
  type: typeof WORK_TOOL_SHOW_REQUEST_EVENT;
  event: WorkToolShowRequest;
};

export type WorkToolShowArgs = {
  surface: WorkToolShowSurface;
  chatSessionId?: string | null;
  laneId?: string | null;
};

/**
 * What a desktop did with a request.
 *
 * `shown`: the surface is on screen now — mounted, laid out, in a visible
 * window. `held`: a window has this project open but the user cannot see the
 * surface yet (another chat is in front, or the window is hidden), so it opens
 * when they go to that chat.
 */
export type WorkToolShowAckStatus = "shown" | "held";

export type WorkToolShowAck = {
  requestId: string;
  status: WorkToolShowAckStatus;
  desktopLabel?: string | null;
};

export type WorkToolShowStatus = WorkToolShowAckStatus | "no_desktop";

export type WorkToolShowResult = {
  status: WorkToolShowStatus;
  surface: WorkToolShowSurface;
  chatSessionId: string;
  requestId: string;
  desktopLabel: string | null;
  message: string;
};

/** The sentence the CLI prints, one per outcome. */
export function describeWorkToolShowResult(
  status: WorkToolShowStatus,
  surface: WorkToolShowSurface,
  desktopLabel: string | null,
): string {
  const name = WORK_TOOL_SHOW_SURFACE_LABELS[surface];
  const where = desktopLabel ? ` on ${desktopLabel}` : "";
  if (status === "shown") return `Showing the ${name}${where}.`;
  if (status === "held") {
    return `A desktop window${where} has this project open, but the user cannot see this chat right now (another chat is in front, or the window is hidden). The ${name} opens when they go to this chat.`;
  }
  return `No desktop window is open for this chat, so nothing was shown. Tell the user to open this chat in ADE Desktop.`;
}

export const WORK_TOOL_SHOW_SURFACE_LABELS: Record<WorkToolShowSurface, string> = {
  apple: "Apple device in the tools pane",
  "floating-apple": "floating Apple device",
  browser: "browser in the tools pane",
  proof: "proof drawer",
};
