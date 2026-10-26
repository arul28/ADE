import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopWebApi } from "../../webclient/adapter/macDesktop";
import type { H264PushSource } from "./h264StreamPlayer";
import type { MacDesktopInputSender } from "./useMacDesktopRealInput";

/**
 * The lane display's live picture on the hosted web client: H.264 records
 * pushed over the sync socket (`macDesktop.streamSubscribe`), in place of the
 * desktop's token-guarded loopback URL. Shared by the watch-only pane and the
 * full pane's web live view.
 */

/** The web `macDesktop` namespace, read defensively: optional on every surface. */
export function macDesktopWebApi(): Partial<MacDesktopWebApi> | null {
  // Through `unknown` on purpose: on the desktop this slot is the Electron IPC
  // namespace, whose `renewLease` takes a `holderId` where the web one takes a
  // token. The type of `window.ade` is the desktop surface.
  const api = typeof window === "undefined"
    ? undefined
    : window.ade?.macDesktop as unknown as Partial<MacDesktopWebApi> | undefined;
  return api ?? null;
}

export function randomMacDesktopSubscriptionId(laneId: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `macdesk-${laneId}-${suffix}`;
}

function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A push-fed record source over the web `macDesktop` namespace. One
 * subscription per source instance; abandoning the source unsubscribes.
 *
 * Records keep the host's sequence numbers: the host skips frames under
 * backpressure and always resumes at a keyframe, and the player's gate uses
 * the gap to hold P-frames whose reference was skipped.
 */
export function createMacDesktopStreamSource(args: {
  api: Partial<MacDesktopWebApi>;
  laneId: string;
  subscriptionId: string;
  viewerLabel: string;
  /**
   * The lane's machine. Every call and listener carries it, so the federated
   * web adapter delivers this stream from the machine the lane lives on.
   */
  runtimePin?: OpenProjectBinding | null;
}): H264PushSource {
  const { api, laneId, subscriptionId, viewerLabel } = args;
  const pin = args.runtimePin ?? undefined;
  return {
    kind: "push",
    subscribe(handlers) {
      let closed = false;
      const offRecord = api.onStreamRecord?.((record) => {
        if (closed || record.subscriptionId !== subscriptionId) return;
        if (record.kind === "config") {
          try {
            const config = JSON.parse(new TextDecoder().decode(decodeBase64Bytes(record.data))) as {
              codec?: unknown;
              width?: unknown;
              height?: unknown;
              annexB?: unknown;
            };
            if (typeof config.codec !== "string" || !config.codec) {
              handlers.onError("The video stream sent no codec.");
              return;
            }
            handlers.onRecord({
              kind: "config",
              codec: config.codec,
              width: typeof config.width === "number" ? config.width : null,
              height: typeof config.height === "number" ? config.height : null,
              annexB: config.annexB !== false,
            });
          } catch {
            handlers.onError("The video stream sent an unreadable configuration.");
          }
          return;
        }
        handlers.onRecord({
          kind: "access-unit",
          keyframe: record.keyframe,
          seq: record.seq,
          bytes: decodeBase64Bytes(record.data),
        });
      }, pin) ?? (() => {});
      const offEnded = api.onStreamEnded?.((ended) => {
        if (closed || ended.subscriptionId !== subscriptionId) return;
        if (ended.reason === "error") {
          handlers.onError(ended.message ?? "The desktop stream failed.");
        } else {
          handlers.onEnd();
        }
      }, pin) ?? (() => {});
      void Promise.resolve(api.streamSubscribe?.({ laneId, subscriptionId, viewerLabel }, pin))
        .then((result) => {
          if (closed || !api.streamSubscribe) return;
          if (!result) handlers.onError("The live desktop view is not available on this host.");
        })
        .catch((error: unknown) => {
          if (closed) return;
          handlers.onError(error instanceof Error ? error.message : String(error));
        });
      return () => {
        closed = true;
        offRecord();
        offEnded();
        void Promise.resolve(api.streamUnsubscribe?.({ subscriptionId }, pin)).catch(() => {
          // A dead socket already released the subscription host-side.
        });
      };
    },
  };
}

/**
 * Real input from the hosted web client: one `macDesktop.input` sync call per
 * event, in place of the desktop's loopback fast path or its IPC dispatch.
 *
 * The host strips every caller-asserted identity and derives the controller
 * from this socket and the tab's token, so the call carries only the event.
 * `releaseCursor` is answered here: a remote controller never asks the host to
 * hold its cursor, so there is nothing to put back and no wire message for it.
 */
export function createMacDesktopWebInputSender(args: {
  laneId: string;
  runtimePin: OpenProjectBinding | null;
}): MacDesktopInputSender {
  const { laneId } = args;
  const pin = args.runtimePin ?? undefined;
  return (call) => {
    const api = macDesktopWebApi();
    if (!api?.input) {
      return Promise.reject(new Error("The host does not accept input from this client."));
    }
    if (call.kind === "releaseCursor") return Promise.resolve(null);
    return api.input({ laneId, call }, pin);
  };
}
