import type { Logger } from "../../desktop/src/main/services/logging/logger";
import { readClientLinkReport, type ClientLinkReport } from "../../desktop/src/shared/slowLinkMode";
import type { JsonRpcHandler } from "./jsonrpc";

/** One summary line per remote connection this often, and one when it closes. */
export const LINK_SUMMARY_INTERVAL_MS = 5 * 60_000;

/**
 * Logs how a remote desktop's connection to this machine goes, at low cost:
 * no per-request lines. A connection counts as remote when it came over a
 * pairing (`peerDeviceId`) or its desktop reported its link on `ping`. The
 * lines say how long it was open, how many requests it sent, and the round
 * trips, drops and slow-connection state the desktop measured, so a flight
 * leaves numbers on both ends.
 */
export function withLinkSummary<H extends JsonRpcHandler & { dispose?: () => void }>(
  handler: H,
  options: {
    logger: Pick<Logger, "info">;
    peerDeviceId: string | null;
    intervalMs?: number;
    now?: () => number;
  },
): H {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? LINK_SUMMARY_INTERVAL_MS;
  const openedAt = now();
  let requests = 0;
  let periodRequests = 0;
  let lastLink: ClientLinkReport | null = null;
  let remote = Boolean(options.peerDeviceId);
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const peer = options.peerDeviceId ? options.peerDeviceId.slice(0, 8) : null;

  const line = (event: string) => {
    options.logger.info(event, {
      peer,
      openForMs: now() - openedAt,
      requests,
      periodRequests,
      clientRttP50Ms: lastLink?.rttP50Ms ?? null,
      clientRttP95Ms: lastLink?.rttP95Ms ?? null,
      clientDrops: lastLink?.drops ?? null,
      clientSlow: lastLink?.slow ?? null,
    });
    periodRequests = 0;
  };
  const startTimer = () => {
    if (timer || closed || !remote) return;
    timer = setInterval(() => line("rpc.link_summary"), intervalMs);
    timer.unref?.();
  };
  startTimer();

  const wrapped = Object.assign(async (request: Parameters<JsonRpcHandler>[0]) => {
    requests += 1;
    periodRequests += 1;
    if (request.method === "ping") {
      const params = request.params as { link?: unknown } | undefined;
      const report = readClientLinkReport(params?.link);
      if (report) {
        lastLink = report;
        remote = true;
        startTimer();
      }
    }
    return await handler(request);
  }, handler);
  wrapped.dispose = () => {
    if (!closed) {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (remote) line("rpc.link_closed");
    }
    handler.dispose?.();
  };
  return wrapped;
}
