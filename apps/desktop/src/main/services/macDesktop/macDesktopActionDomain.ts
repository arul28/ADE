/**
 * The `mac_desktop` action domain: one private macOS screen per lane, reached
 * by agents and by `ade mac-desktop` through the action bus.
 *
 * Only argument reading and the platform gate live here. Every method is one
 * call on `MacDesktopServiceApi`; nothing in this file decides policy, which is
 * `actionPolicy.ts`'s job, and nothing touches the driver.
 *
 * Kept beside the service rather than inside `adeActions/registry.ts` because
 * the seven readers below are this domain's grammar — `handle` / `text` / `x,y`
 * targets, the modifier set, the resolution presets — and they belong with the
 * contract they read, not in a file that wires every domain in ADE.
 */

import {
  MAC_DESKTOP_MACOS_ONLY_MESSAGE,
  MAC_DESKTOP_RESOLUTION_PRESETS,
  MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
  type MacDesktopInputMode,
  type MacDesktopResolutionPreset,
  type MacDesktopServiceApi,
  type MacDesktopTarget,
} from "../../../shared/types/macDesktop";

/** What the registry passes in. Exactly the one field this domain reads. */
export type MacDesktopActionRuntime = {
  macDesktopService?: MacDesktopServiceApi | null;
};

/**
 * The registry's opaque service shape: a bag of methods taking unknown args.
 * Re-declared rather than imported to keep this module free of the registry.
 */
type OpaqueService = Record<string, (args?: unknown) => unknown>;

/* ──────────────────────────────────────────────────────────────────────────
   MAC DESKTOP.

   One private macOS screen per lane, reached by agents through this domain.

   `AdeRuntime.macDesktopService` is the one source; a runtime that built no
   service (a chat-only brain, or any non-macOS host that still serves actions)
   leaves it null and the whole domain is simply absent.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * The rejection every Mac Desktop action carries off macOS.
 *
 * Shaped like the iOS simulator's coded errors — `CODE: message` — because the
 * daemon flattens a thrown error to its message string, so the code prefix is
 * the only thing the CLI's hint table can key on. The `code` property is there
 * for in-process callers that never cross the wire.
 */
class MacDesktopUnsupportedPlatformError extends Error {
  readonly code = MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE;
  constructor() {
    super(`${MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE}: ${MAC_DESKTOP_MACOS_ONLY_MESSAGE}`);
    this.name = "MacDesktopUnsupportedPlatformError";
  }
}

function macDesktopArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function macDesktopRequiredLaneId(args: unknown, action: string): string {
  const laneId = macDesktopArgs(args).laneId;
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  if (!trimmed) throw new Error(`macDesktop.${action} requires laneId.`);
  return trimmed;
}

function macDesktopOptionalLaneId(args: unknown): string | null {
  const laneId = macDesktopArgs(args).laneId;
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  return trimmed.length ? trimmed : null;
}

function macDesktopOptionalString(args: unknown, key: string): string | null {
  const value = macDesktopArgs(args)[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

function macDesktopRequiredString(args: unknown, key: string, action: string): string {
  const value = macDesktopOptionalString(args, key);
  if (!value) throw new Error(`macDesktop.${action} requires ${key}.`);
  return value;
}

function macDesktopOptionalNumber(args: unknown, key: string): number | null {
  const value = macDesktopArgs(args)[key];
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`macDesktop: ${key} must be a number.`);
  return parsed;
}

function macDesktopOptionalBoolean(args: unknown, key: string): boolean | null {
  const value = macDesktopArgs(args)[key];
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`macDesktop: ${key} must be a boolean.`);
}

const MAC_DESKTOP_INPUT_MODES: readonly MacDesktopInputMode[] = ["accessibility", "real"];
const MAC_DESKTOP_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
/**
 * Derived, never re-typed: a preset added to the shared table and forgotten
 * here was an action that refused a resolution the service supports.
 */
const MAC_DESKTOP_RESOLUTIONS = Object.keys(
  MAC_DESKTOP_RESOLUTION_PRESETS,
) as MacDesktopResolutionPreset[];

function macDesktopEnum<T extends string>(
  args: unknown,
  key: string,
  valid: readonly T[],
  action: string,
): T | null {
  const raw = macDesktopOptionalString(args, key);
  if (!raw) return null;
  const match = valid.find((entry) => entry === raw);
  if (!match) {
    throw new Error(
      `macDesktop.${action}: unknown ${key} '${raw}'. Valid values: ${valid.join(", ")}.`,
    );
  }
  return match;
}

function macDesktopMode(args: unknown, action: string): MacDesktopInputMode | null {
  return macDesktopEnum(args, "mode", MAC_DESKTOP_INPUT_MODES, action);
}

/** The handle/text/point trio every acting command resolves a target from. */
function macDesktopTarget(source: unknown): MacDesktopTarget {
  const handle = macDesktopOptionalString(source, "handle");
  const text = macDesktopOptionalString(source, "text");
  const x = macDesktopOptionalNumber(source, "x");
  const y = macDesktopOptionalNumber(source, "y");
  const windowId = macDesktopOptionalNumber(source, "windowId");
  return {
    ...(handle ? { handle } : {}),
    ...(text ? { text } : {}),
    ...(x == null ? {} : { x }),
    ...(y == null ? {} : { y }),
    ...(windowId == null ? {} : { windowId }),
  };
}

function macDesktopRequiredTarget(source: unknown, label: string, action: string): MacDesktopTarget {
  const target = macDesktopTarget(source);
  if (Object.keys(target).length === 0) {
    throw new Error(`macDesktop.${action} requires ${label} as handle, text, or x/y.`);
  }
  return target;
}

export function buildMacDesktopDomainService(runtime: MacDesktopActionRuntime): OpaqueService | null {
  const service: MacDesktopServiceApi | null = runtime.macDesktopService ?? null;
  if (!service) return null;
  /**
   * One gate in front of every method but `getStatus`.
   *
   * `getStatus` answers on every platform — that asymmetry is the capability
   * contract, and a read that throws cannot tell a non-Mac client why it is
   * being refused. Everything else refuses here rather than in the service, so
   * a host whose service exists but whose platform cannot host a display gives
   * one message with one code.
   */
  const supported = async (): Promise<void> => {
    const status = await service.getStatus();
    if (!status.supported) throw new MacDesktopUnsupportedPlatformError();
  };
  const gated = <T>(run: () => Promise<T>): Promise<T> => supported().then(run);
  const chatSessionId = (args: unknown): { chatSessionId?: string } => {
    const value = macDesktopOptionalString(args, "chatSessionId");
    return value ? { chatSessionId: value } : {};
  };
  /**
   * Who is asking, when it is not a chat.
   *
   * A human takeover holds the lease under the controller id the viewing client
   * minted, never under a chat session id, so an acting command from that client
   * has to be able to say which holder it is. It authorizes nothing by itself —
   * the service still refuses an id that does not hold the lease.
   */
  const controllerId = (args: unknown): { controllerId?: string } => {
    const value = macDesktopOptionalString(args, "controllerId");
    return value ? { controllerId: value } : {};
  };
  return {
    getStatus: (args?: unknown) => service.getStatus({
      laneId: macDesktopOptionalLaneId(args),
      ...chatSessionId(args),
    }),
    start: (args?: unknown) => gated(() => service.start({
      laneId: macDesktopRequiredLaneId(args, "start"),
      resolution: macDesktopEnum(args, "resolution", MAC_DESKTOP_RESOLUTIONS, "start"),
      laneName: macDesktopOptionalString(args, "laneName"),
      ...chatSessionId(args),
    })),
    stop: (args?: unknown) => gated(() => service.stop({
      laneId: macDesktopRequiredLaneId(args, "stop"),
      ...chatSessionId(args),
    })),
    listWindows: (args?: unknown) => gated(() => service.listWindows({
      laneId: macDesktopOptionalLaneId(args),
    })),
    open: (args?: unknown) => gated(() => {
      const rawArgs = macDesktopArgs(args).args;
      return service.open({
        laneId: macDesktopRequiredLaneId(args, "open"),
        target: macDesktopRequiredString(args, "target", "open"),
        args: Array.isArray(rawArgs) ? rawArgs.map((entry) => String(entry)) : null,
        ...chatSessionId(args),
      });
    }),
    claimWindow: (args?: unknown) => gated(() => {
      const windowId = macDesktopOptionalNumber(args, "windowId");
      if (windowId == null) throw new Error("macDesktop.claimWindow requires windowId.");
      return service.claimWindow({
        laneId: macDesktopRequiredLaneId(args, "claimWindow"),
        windowId,
        ...chatSessionId(args),
      });
    }),
    releaseWindow: (args?: unknown) => gated(() => service.releaseWindow({
      laneId: macDesktopRequiredLaneId(args, "releaseWindow"),
      windowId: macDesktopOptionalNumber(args, "windowId"),
    })),
    observe: (args?: unknown) => gated(() => service.observe({
      laneId: macDesktopRequiredLaneId(args, "observe"),
      windowId: macDesktopOptionalNumber(args, "windowId"),
      map: macDesktopOptionalBoolean(args, "map"),
      limit: macDesktopOptionalNumber(args, "limit"),
      ...chatSessionId(args),
    })),
    click: (args?: unknown) => gated(() => service.click({
      laneId: macDesktopRequiredLaneId(args, "click"),
      ...macDesktopRequiredTarget(args, "a target", "click"),
      mode: macDesktopMode(args, "click"),
      button: macDesktopEnum(args, "button", ["left", "right"] as const, "click"),
      count: macDesktopOptionalNumber(args, "count"),
      ...chatSessionId(args),
      ...controllerId(args),
    })),
    type: (args?: unknown) => gated(() => {
      const text = macDesktopArgs(args).text;
      if (typeof text !== "string") throw new Error("macDesktop.type requires text.");
      const target = macDesktopTarget(macDesktopArgs(args).target ?? {});
      return service.type({
        laneId: macDesktopRequiredLaneId(args, "type"),
        text,
        clear: macDesktopOptionalBoolean(args, "clear"),
        mode: macDesktopMode(args, "type"),
        target: Object.keys(target).length ? target : null,
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    press: (args?: unknown) => gated(() => {
      const modifiers = macDesktopArgs(args).modifiers;
      const valid = ["cmd", "shift", "option", "control"] as const;
      const parsed = Array.isArray(modifiers)
        ? modifiers.map((entry) => {
          const match = valid.find((value) => value === entry);
          if (!match) throw new Error(`macDesktop.press: unknown modifier '${String(entry)}'.`);
          return match;
        })
        : null;
      return service.press({
        laneId: macDesktopRequiredLaneId(args, "press"),
        key: macDesktopRequiredString(args, "key", "press"),
        modifiers: parsed,
        mode: macDesktopMode(args, "press"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    scroll: (args?: unknown) => gated(() => {
      const direction = macDesktopEnum(args, "direction", MAC_DESKTOP_SCROLL_DIRECTIONS, "scroll");
      if (!direction) throw new Error("macDesktop.scroll requires direction (up, down, left, right).");
      return service.scroll({
        laneId: macDesktopRequiredLaneId(args, "scroll"),
        ...macDesktopTarget(args),
        direction,
        amount: macDesktopOptionalNumber(args, "amount"),
        mode: macDesktopMode(args, "scroll"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    drag: (args?: unknown) => gated(() => service.drag({
      laneId: macDesktopRequiredLaneId(args, "drag"),
      from: macDesktopRequiredTarget(macDesktopArgs(args).from, "from", "drag"),
      to: macDesktopRequiredTarget(macDesktopArgs(args).to, "to", "drag"),
      durationMs: macDesktopOptionalNumber(args, "durationMs"),
      mode: macDesktopMode(args, "drag"),
      ...chatSessionId(args),
      ...controllerId(args),
    })),
    wait: (args?: unknown) => gated(() => {
      const text = macDesktopOptionalString(args, "text");
      const gone = macDesktopOptionalString(args, "gone");
      const windowTitle = macDesktopOptionalString(args, "windowTitle");
      if (!text && !gone && !windowTitle) {
        throw new Error("macDesktop.wait requires one of text, gone, or windowTitle.");
      }
      return service.wait({
        laneId: macDesktopRequiredLaneId(args, "wait"),
        text,
        gone,
        windowTitle,
        timeoutMs: macDesktopOptionalNumber(args, "timeoutMs"),
        ...chatSessionId(args),
      });
    }),
    screenshot: (args?: unknown) => gated(() => service.screenshot({
      laneId: macDesktopRequiredLaneId(args, "screenshot"),
      windowId: macDesktopOptionalNumber(args, "windowId"),
      out: macDesktopOptionalString(args, "out"),
      ...chatSessionId(args),
    })),
    startRecording: (args?: unknown) => gated(() => service.startRecording({
      laneId: macDesktopRequiredLaneId(args, "startRecording"),
      caption: macDesktopOptionalString(args, "caption"),
      fps: macDesktopOptionalNumber(args, "fps"),
      ...chatSessionId(args),
    })),
    stopRecording: (args?: unknown) => gated(() => service.stopRecording({
      laneId: macDesktopRequiredLaneId(args, "stopRecording"),
      ...chatSessionId(args),
    })),
    getStreamStatus: (args?: unknown) => gated(() => service.getStreamStatus({
      laneId: macDesktopRequiredLaneId(args, "getStreamStatus"),
    })),
    requestInputLease: (args?: unknown) => gated(() => service.requestInputLease({
      laneId: macDesktopRequiredLaneId(args, "requestInputLease"),
      chatSessionId: macDesktopRequiredString(args, "chatSessionId", "requestInputLease"),
      reason: macDesktopOptionalString(args, "reason"),
    })),
    present: (args?: unknown) => gated(() => {
      const destination = macDesktopEnum(args, "destination", ["main", "display"] as const, "present");
      if (!destination) throw new Error("macDesktop.present requires destination (main or display).");
      return service.present({ laneId: macDesktopRequiredLaneId(args, "present"), destination });
    }),
    // CTO-only in `ADE_ACTION_CTO_ONLY`: the stream token and the human
    // takeover belong to a viewing client, not to a session-bound agent.
    startStream: (args?: unknown) => gated(() => service.startStream({
      laneId: macDesktopRequiredLaneId(args, "startStream"),
      fps: macDesktopOptionalNumber(args, "fps"),
      idleFps: macDesktopOptionalNumber(args, "idleFps"),
      ...chatSessionId(args),
    })),
    stopStream: (args?: unknown) => gated(() => service.stopStream({
      laneId: macDesktopRequiredLaneId(args, "stopStream"),
    })),
    takeControl: (args?: unknown) => gated(() => service.takeControl({
      laneId: macDesktopRequiredLaneId(args, "takeControl"),
      controllerId: macDesktopRequiredString(args, "controllerId", "takeControl"),
      controllerLabel: macDesktopOptionalString(args, "controllerLabel"),
    })),
    returnControl: (args?: unknown) => gated(() => service.returnControl({
      laneId: macDesktopRequiredLaneId(args, "returnControl"),
      controllerId: macDesktopRequiredString(args, "controllerId", "returnControl"),
    })),
    renewLease: (args?: unknown) => gated(() => service.renewLease({
      laneId: macDesktopRequiredLaneId(args, "renewLease"),
      holderId: macDesktopRequiredString(args, "holderId", "renewLease"),
    })),
  };
}

