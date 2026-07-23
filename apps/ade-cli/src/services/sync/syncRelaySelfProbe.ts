import { WebSocket, type RawData } from "ws";

export const RELAY_SELF_PROBE_TIMEOUT_MS = 15_000;
const RELAY_READY_VERSION = 2;

export type RelaySelfProbeResult =
  | { ok: true; roundTripMs: number }
  | { ok: false; reason: string };

type RelaySelfProbeArgs = {
  relayWsBase: string;
  machineKey: string;
  timeoutMs?: number;
  createWebSocket?: (url: string) => WebSocket;
};

function rawText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

function expectedFrame(raw: RawData, type: "accepted" | "ready"): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText(raw));
  } catch {
    return false;
  }
  return Boolean(
    parsed
    && typeof parsed === "object"
    && (parsed as { t?: unknown }).t === type
    && (parsed as { v?: unknown }).v === RELAY_READY_VERSION,
  );
}

function closeDetail(code: number, rawReason: Buffer): string {
  const reason = rawReason.toString("utf8").trim();
  return reason ? ` (${code}): ${reason}` : ` (${code})`;
}

export function probeRelayEndToEnd(
  args: RelaySelfProbeArgs,
): Promise<RelaySelfProbeResult> {
  const timeoutMs = Math.max(1, Math.floor(args.timeoutMs ?? RELAY_SELF_PROBE_TIMEOUT_MS));
  const relayWsBase = args.relayWsBase.replace(/\/+$/, "");
  const url = `${relayWsBase}/connect/${args.machineKey}?ready=2`;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = args.createWebSocket?.(url) ?? new WebSocket(url);
    } catch (error) {
      resolve({
        ok: false,
        reason: `Relay self-probe could not open a WebSocket: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    let settled = false;
    let accepted = false;
    const finish = (result: RelaySelfProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(result);
      if (!result.ok) {
        try {
          socket.terminate();
        } catch {
          // already closed
        }
      }
    };
    const onMessage = (raw: RawData, isBinary: boolean): void => {
      if (isBinary) {
        finish({
          ok: false,
          reason: accepted
            ? "Relay self-probe received a binary frame before ready."
            : "Relay self-probe received a binary first frame.",
        });
        return;
      }
      if (!accepted) {
        if (!expectedFrame(raw, "accepted")) {
          finish({ ok: false, reason: "Relay self-probe received an invalid first frame; expected accepted v2." });
          return;
        }
        accepted = true;
        return;
      }
      if (!expectedFrame(raw, "ready")) {
        finish({ ok: false, reason: "Relay self-probe received an invalid second frame; expected ready v2." });
        return;
      }
      const roundTripMs = Math.max(0, Date.now() - startedAt);
      finish({ ok: true, roundTripMs });
      try {
        socket.close(1000, "self probe complete");
      } catch {
        // The successful readiness verdict is already complete.
      }
    };
    const onClose = (code: number, reason: Buffer): void => {
      finish({
        ok: false,
        reason: `Relay self-probe closed before ${accepted ? "ready" : "accepted"}${closeDetail(code, reason)}.`,
      });
    };
    const onError = (error: Error): void => {
      finish({
        ok: false,
        reason: `Relay self-probe WebSocket error: ${error.message}`,
      });
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: `Relay self-probe timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);
    timer.unref?.();

    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
