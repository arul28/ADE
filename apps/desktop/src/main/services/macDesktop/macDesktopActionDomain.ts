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

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function requiredLaneId(args: unknown, action: string): string {
  const laneId = objectArgs(args).laneId;
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  if (!trimmed) throw new Error(`macDesktop.${action} requires laneId.`);
  return trimmed;
}

function optionalLaneId(args: unknown): string | null {
  const laneId = objectArgs(args).laneId;
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  return trimmed.length ? trimmed : null;
}

function optionalString(args: unknown, key: string): string | null {
  const value = objectArgs(args)[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

function requiredString(args: unknown, key: string, action: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`macDesktop.${action} requires ${key}.`);
  return value;
}

function optionalNumber(args: unknown, key: string): number | null {
  const value = objectArgs(args)[key];
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`macDesktop: ${key} must be a number.`);
  return parsed;
}

function optionalBoolean(args: unknown, key: string): boolean | null {
  const value = objectArgs(args)[key];
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

function enumOf<T extends string>(
  args: unknown,
  key: string,
  valid: readonly T[],
  action: string,
): T | null {
  const raw = optionalString(args, key);
  if (!raw) return null;
  const match = valid.find((entry) => entry === raw);
  if (!match) {
    throw new Error(
      `macDesktop.${action}: unknown ${key} '${raw}'. Valid values: ${valid.join(", ")}.`,
    );
  }
  return match;
}

function inputMode(args: unknown, action: string): MacDesktopInputMode | null {
  return enumOf(args, "mode", MAC_DESKTOP_INPUT_MODES, action);
}

/** The handle/text/point trio every acting command resolves a target from. */
function targetOf(source: unknown): MacDesktopTarget {
  const handle = optionalString(source, "handle");
  const text = optionalString(source, "text");
  const x = optionalNumber(source, "x");
  const y = optionalNumber(source, "y");
  const windowId = optionalNumber(source, "windowId");
  return {
    ...(handle ? { handle } : {}),
    ...(text ? { text } : {}),
    ...(x == null ? {} : { x }),
    ...(y == null ? {} : { y }),
    ...(windowId == null ? {} : { windowId }),
  };
}

function requiredTargetOf(source: unknown, label: string, action: string): MacDesktopTarget {
  const target = targetOf(source);
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
    const value = optionalString(args, "chatSessionId");
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
    const value = optionalString(args, "controllerId");
    return value ? { controllerId: value } : {};
  };
  return {
    getStatus: (args?: unknown) => service.getStatus({
      laneId: optionalLaneId(args),
      ...chatSessionId(args),
    }),
    /**
     * "Try again" after a grant. Restarts the helper so a grant macOS made
     * after it started is visible, then re-probes. CTO-only, because it is a
     * person's remediation rather than an agent's.
     */
    recheckPermissions: (args?: unknown) => gated(() => service.recheckPermissions({
      restartDriver: optionalBoolean(args, "restartDriver") ?? undefined,
    })),
    /**
     * "Ask macOS" for a grant. The driver prompts only when the service passes
     * `allowPrompt`, which the service decides from the origin, so this cannot
     * be talked into prompting by anything on the bus. CTO-only for the same
     * reason as `recheckPermissions`.
     */
    requestPermission: (args?: unknown) => gated(() => {
      const which = enumOf(args, "which", ["screenRecording", "accessibility"] as const, "requestPermission");
      if (!which) {
        throw new Error("macDesktop.requestPermission requires which (screenRecording or accessibility).");
      }
      return service.requestPermission({ which });
    }),
    start: (args?: unknown) => gated(() => service.start({
      laneId: requiredLaneId(args, "start"),
      resolution: enumOf(args, "resolution", MAC_DESKTOP_RESOLUTIONS, "start"),
      laneName: optionalString(args, "laneName"),
      ...chatSessionId(args),
    })),
    stop: (args?: unknown) => gated(() => service.stop({
      laneId: requiredLaneId(args, "stop"),
      ...chatSessionId(args),
    })),
    listWindows: (args?: unknown) => gated(() => service.listWindows({
      laneId: optionalLaneId(args),
    })),
    open: (args?: unknown) => gated(() => {
      const rawArgs = objectArgs(args).args;
      return service.open({
        laneId: requiredLaneId(args, "open"),
        target: requiredString(args, "target", "open"),
        args: Array.isArray(rawArgs) ? rawArgs.map((entry) => String(entry)) : null,
        ...chatSessionId(args),
      });
    }),
    claimWindow: (args?: unknown) => gated(() => {
      const windowId = optionalNumber(args, "windowId");
      if (windowId == null) throw new Error("macDesktop.claimWindow requires windowId.");
      return service.claimWindow({
        laneId: requiredLaneId(args, "claimWindow"),
        windowId,
        ...chatSessionId(args),
      });
    }),
    releaseWindow: (args?: unknown) => gated(() => service.releaseWindow({
      laneId: requiredLaneId(args, "releaseWindow"),
      windowId: optionalNumber(args, "windowId"),
    })),
    observe: (args?: unknown) => gated(() => service.observe({
      laneId: requiredLaneId(args, "observe"),
      windowId: optionalNumber(args, "windowId"),
      map: optionalBoolean(args, "map"),
      limit: optionalNumber(args, "limit"),
      ...chatSessionId(args),
    })),
    click: (args?: unknown) => gated(() => service.click({
      laneId: requiredLaneId(args, "click"),
      ...requiredTargetOf(args, "a target", "click"),
      mode: inputMode(args, "click"),
      button: enumOf(args, "button", ["left", "right"] as const, "click"),
      count: optionalNumber(args, "count"),
      silent: optionalBoolean(args, "silent"),
      ...chatSessionId(args),
      ...controllerId(args),
    })),
    type: (args?: unknown) => gated(() => {
      const text = objectArgs(args).text;
      if (typeof text !== "string") throw new Error("macDesktop.type requires text.");
      const target = targetOf(objectArgs(args).target ?? {});
      return service.type({
        laneId: requiredLaneId(args, "type"),
        text,
        clear: optionalBoolean(args, "clear"),
        submit: optionalBoolean(args, "submit"),
        mode: inputMode(args, "type"),
        target: Object.keys(target).length ? target : null,
        silent: optionalBoolean(args, "silent"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    press: (args?: unknown) => gated(() => {
      const modifiers = objectArgs(args).modifiers;
      const valid = ["cmd", "shift", "option", "control"] as const;
      const parsed = Array.isArray(modifiers)
        ? modifiers.map((entry) => {
          const match = valid.find((value) => value === entry);
          if (!match) throw new Error(`macDesktop.press: unknown modifier '${String(entry)}'.`);
          return match;
        })
        : null;
      return service.press({
        laneId: requiredLaneId(args, "press"),
        key: requiredString(args, "key", "press"),
        modifiers: parsed,
        mode: inputMode(args, "press"),
        silent: optionalBoolean(args, "silent"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    scroll: (args?: unknown) => gated(() => {
      const direction = enumOf(args, "direction", MAC_DESKTOP_SCROLL_DIRECTIONS, "scroll");
      if (!direction) throw new Error("macDesktop.scroll requires direction (up, down, left, right).");
      return service.scroll({
        laneId: requiredLaneId(args, "scroll"),
        ...targetOf(args),
        direction,
        amount: optionalNumber(args, "amount"),
        mode: inputMode(args, "scroll"),
        silent: optionalBoolean(args, "silent"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    drag: (args?: unknown) => gated(() => service.drag({
      laneId: requiredLaneId(args, "drag"),
      from: requiredTargetOf(objectArgs(args).from, "from", "drag"),
      to: requiredTargetOf(objectArgs(args).to, "to", "drag"),
      durationMs: optionalNumber(args, "durationMs"),
      mode: inputMode(args, "drag"),
      silent: optionalBoolean(args, "silent"),
      ...chatSessionId(args),
      ...controllerId(args),
    })),
    /**
     * The pointer, moved.
     *
     * Two required numbers and nothing else to get wrong: no target grammar,
     * because "move to the element called Save" is a click's problem, and no
     * mode, because there is no accessibility way to move a pointer.
     */
    move: (args?: unknown) => gated(() => {
      const x = optionalNumber(args, "x");
      const y = optionalNumber(args, "y");
      if (x == null || y == null) throw new Error("macDesktop.move requires x and y.");
      return service.move({
        laneId: requiredLaneId(args, "move"),
        x,
        y,
        silent: optionalBoolean(args, "silent"),
        ...chatSessionId(args),
        ...controllerId(args),
      });
    }),
    wait: (args?: unknown) => gated(() => {
      const text = optionalString(args, "text");
      const gone = optionalString(args, "gone");
      const windowTitle = optionalString(args, "windowTitle");
      if (!text && !gone && !windowTitle) {
        throw new Error("macDesktop.wait requires one of text, gone, or windowTitle.");
      }
      return service.wait({
        laneId: requiredLaneId(args, "wait"),
        text,
        gone,
        windowTitle,
        timeoutMs: optionalNumber(args, "timeoutMs"),
        ...chatSessionId(args),
      });
    }),
    screenshot: (args?: unknown) => gated(() => service.screenshot({
      laneId: requiredLaneId(args, "screenshot"),
      windowId: optionalNumber(args, "windowId"),
      out: optionalString(args, "out"),
      caption: optionalString(args, "caption"),
      ...chatSessionId(args),
    })),
    startRecording: (args?: unknown) => gated(() => service.startRecording({
      laneId: requiredLaneId(args, "startRecording"),
      caption: optionalString(args, "caption"),
      fps: optionalNumber(args, "fps"),
      keepIdle: optionalBoolean(args, "keepIdle"),
      maxSeconds: optionalNumber(args, "maxSeconds"),
      ...chatSessionId(args),
    })),
    stopRecording: (args?: unknown) => gated(() => service.stopRecording({
      laneId: requiredLaneId(args, "stopRecording"),
      ...chatSessionId(args),
    })),
    getStreamStatus: (args?: unknown) => gated(() => service.getStreamStatus({
      laneId: requiredLaneId(args, "getStreamStatus"),
    })),
    requestInputLease: (args?: unknown) => gated(() => service.requestInputLease({
      laneId: requiredLaneId(args, "requestInputLease"),
      chatSessionId: requiredString(args, "chatSessionId", "requestInputLease"),
      reason: optionalString(args, "reason"),
    })),
    present: (args?: unknown) => gated(() => {
      const destination = enumOf(args, "destination", ["main", "display"] as const, "present");
      if (!destination) throw new Error("macDesktop.present requires destination (main or display).");
      return service.present({ laneId: requiredLaneId(args, "present"), destination });
    }),
    // CTO-only in `ADE_ACTION_CTO_ONLY`: the stream token and the human
    // takeover belong to a viewing client, not to a session-bound agent.
    startStream: (args?: unknown) => gated(() => service.startStream({
      laneId: requiredLaneId(args, "startStream"),
      fps: optionalNumber(args, "fps"),
      idleFps: optionalNumber(args, "idleFps"),
      // A remote desktop's Reconnect: see `MacDesktopStartStreamArgs.fresh`.
      fresh: optionalBoolean(args, "fresh"),
      ...chatSessionId(args),
    })),
    stopStream: (args?: unknown) => gated(() => service.stopStream({
      laneId: requiredLaneId(args, "stopStream"),
      ...chatSessionId(args),
      // A remote desktop's viewer leaving: drop only that viewer.
      ...(optionalBoolean(args, "localViewer") ? { localViewer: true } : {}),
    })),
    takeControl: (args?: unknown) => gated(() => service.takeControl({
      laneId: requiredLaneId(args, "takeControl"),
      controllerId: requiredString(args, "controllerId", "takeControl"),
      controllerLabel: optionalString(args, "controllerLabel"),
    })),
    returnControl: (args?: unknown) => gated(() => service.returnControl({
      laneId: requiredLaneId(args, "returnControl"),
      controllerId: requiredString(args, "controllerId", "returnControl"),
    })),
    renewLease: (args?: unknown) => gated(() => service.renewLease({
      laneId: requiredLaneId(args, "renewLease"),
      holderId: requiredString(args, "holderId", "renewLease"),
    })),
  };
}

