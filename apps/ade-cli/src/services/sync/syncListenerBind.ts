import http from "node:http";
import { WebSocketServer } from "ws";
import {
  DEFAULT_SYNC_HOST_PORT,
  SYNC_HOST_MAX_PORT,
} from "./syncProtocol";
import {
  isLoopbackShadowedError,
  LoopbackShadowedError,
} from "./syncLoopbackProbe";
import {
  channelServeIdentity,
  isStaleChannelServeCommandLine,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  terminatePidGracefullyAsync,
} from "../../serviceManager/common";
import { getRuntimeServiceMainPid } from "../../serviceManager";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import type { SyncListenerPortDiagnosis } from "./syncListenerPortInspect";

/**
 * Bind policy for the shared sync listener: which port it may take, who
 * already holds one, and the attempt plan that reaches a free port.
 *
 * This is the second responsibility split out of the port controller, so both
 * files stay readable: the controller keeps the verdicts, the move lock, the
 * moves, the side door, self-heal and the lifecycle. Nothing here owns state.
 * The controller injects the server factory, the loopback and LAN probes, and
 * the callback that adopts a bound server, so the outcome of a bind is applied
 * synchronously in the place that already guarded for shutdown.
 */

export type SyncListenerLogger = {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type SyncListenerBindOptions = { migrate?: boolean };

export type SyncListenerBindDeps = {
  logger: SyncListenerLogger;
  bindHost: string;
  /** True when the bind host is loopback-only, so no other address can shadow it. */
  bindsLoopbackOnly: boolean;
  createServerPair: () => { httpServer: http.Server; wsServer: WebSocketServer };
  /** True after `closeEntrances`; a bind that notices closes what it bound. */
  isClosed: () => boolean;
  /** Validate and record the verdict; used by the initial bind's candidates. */
  validateLoopback: (port: number) => Promise<void>;
  /** Validate a candidate without recording a verdict; used by a move. */
  assertLoopback: (port: number) => Promise<unknown>;
  /** The LAN shadow probe the self-check shares. */
  findShadowedLocalAddress: (port: number) => Promise<string | null>;
  inspectPort: (port: number) => SyncListenerPortDiagnosis | Promise<SyncListenerPortDiagnosis>;
  activeServicePid?: () => number | null;
  terminatePid?: (pid: number) => Promise<void>;
  /**
   * Adopt a server that bound. Called synchronously inside the bind, right
   * after its `closed` re-check, so shutdown cannot interleave with the
   * assignment.
   */
  onBound: (server: WebSocketServer, httpServer: http.Server, port: number) => void;
  /**
   * Record a move winner's verdict (validated during the bind without being
   * recorded). Called right after `onBound`, never before: status subscribers
   * read the live server, which must already be the new one.
   */
  recordMoveWinner: (port: number) => void;
};

// How long to insist on the preferred port before drifting: 8 × 400ms ≈ 3.2s,
// enough for a dying listener from a previous brain process (or a sibling host
// being replaced) to free the port paired phones have saved. The shared
// listener and a standalone sync host use the same rule.
export const PREFERRED_PORT_BIND_ATTEMPTS = 8;
export const PREFERRED_PORT_BIND_RETRY_DELAY_MS = 400;

/** A bind error worth trying the next candidate (or the same one again) for. */
export function isRetryableListenerBindError(error: unknown): boolean {
  if (isLoopbackShadowedError(error)) return true;
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  return code === "EADDRINUSE" || code === "EACCES";
}

export async function closeCandidateServer(
  candidateServer: WebSocketServer,
  candidateHttpServer: http.Server,
): Promise<void> {
  for (const client of candidateServer.clients) {
    try {
      client.terminate();
    } catch {
      // ignore cleanup failures on a rejected candidate
    }
  }
  // Closing the WebSocketServer only detaches its listeners from the
  // externally-supplied http server; the http server owns the port and must be
  // closed explicitly so a rejected candidate does not leak the bind. ws's
  // close() for an external server resolves only after every client drains, so
  // close the http server directly (forcing lingering sockets) instead.
  try {
    candidateServer.close();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    if (!candidateHttpServer.listening) {
      resolve();
      return;
    }
    try {
      candidateHttpServer.close(() => resolve());
      candidateHttpServer.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}

export function createListenerBinder(
  deps: SyncListenerBindDeps,
): (portCandidates: number[], bindOptions?: SyncListenerBindOptions) => Promise<number> {
  const logger = deps.logger;
  const bindHost = deps.bindHost;
  // A loopback-only bind has no other address to keep serving: a shadow on
  // its port means moving. A wildcard bind keeps its port (see the side door).
  const bindsLoopbackOnly = deps.bindsLoopbackOnly;
  const {
    createServerPair,
    isClosed,
    validateLoopback,
    assertLoopback,
    findShadowedLocalAddress,
    inspectPort,
  } = deps;
  const activeServicePid = deps.activeServicePid ?? getRuntimeServiceMainPid;
  const serviceCommand = resolveAdeServeCommand();
  const staleServeMatch = {
    cliScriptPath: resolveAdeServeCliScriptPath(serviceCommand),
    primarySocketPath: resolveMachineAdeLayout().socketPath,
  };
  // A holder `findStaleHolder` matches names this channel's primary endpoint, so
  // that endpoint is where a cooperative shutdown request goes. Windows has no
  // catchable SIGTERM, so without this the reap was a `TerminateProcess` of a brain
  // mid-write. The last-resort kill is a verified kill: the process is read again at
  // kill time and must still be this channel's brain. A holder that is not proven
  // is left running, and the caller treats the port as still occupied.
  const terminatePid = deps.terminatePid ?? (async (pid: number) => {
    const outcome = await terminatePidGracefullyAsync(pid, {
      runtimeSocketPath: staleServeMatch.primarySocketPath,
      isExpectedProcess: channelServeIdentity(staleServeMatch),
    });
    if (outcome !== "stopped" && outcome !== "killed") {
      throw new Error(`stale sync holder ${pid} could not be verified and was left running`);
    }
  });
  const findStaleHolder = (
    diagnosis: SyncListenerPortDiagnosis,
  ): SyncListenerPortDiagnosis["holders"][number] | null => {
    // Only exclude ourselves. Launchd's tracked main pid is often the wedged
    // predecessor still bound to 8787; excluding it is how a replacement brain
    // ended up stuck on 8788 with two listeners on the same machine.
    const excludedPids = new Set([process.pid]);
    return diagnosis.holders.find((holder) =>
      !excludedPids.has(holder.pid)
      && holder.command != null
      && isStaleChannelServeCommandLine(holder.command, staleServeMatch),
    ) ?? null;
  };

  const bindOnce = async (
    portCandidates: number[],
    bindOptions: SyncListenerBindOptions = {},
  ): Promise<number> => {
    const candidates = portCandidates.length > 0 ? portCandidates : [DEFAULT_SYNC_HOST_PORT];
    const recordCandidateStatus = !bindOptions.migrate;
    // A fixed preferred port is re-attempted so a dying listener can free it.
    // An ephemeral port (0) is ALSO re-attempted, but for a different reason:
    // each bind(0) yields a fresh OS-assigned port, so a loopback shadow on the
    // first resolved port is escaped simply by re-binding. Both are bounded by
    // PREFERRED_PORT_BIND_ATTEMPTS so a persistent shadow still terminates.
    // Runtime migrate probes one candidate; the 3.2s retry storm is for the
    // initial bind, not a 15s heal loop against a live ADE Beta on 8787.
    const attemptPlan = bindOptions.migrate
      ? [...candidates]
      : candidates.flatMap((candidatePort, candidateIndex) =>
        (candidateIndex === 0 && candidatePort !== 0) || candidatePort === 0
          ? Array.from({ length: PREFERRED_PORT_BIND_ATTEMPTS }, () => candidatePort)
          : [candidatePort],
      );
    let lastError: unknown = null;
    let previousAttemptedPort: number | null = null;
    // Tracks RESOLVED shadowed ports. For port 0 the literal 0 is never added
    // (each re-bind resolves a different port), so a shadow on one ephemeral
    // port does not short-circuit the remaining fresh-port attempts.
    const shadowedPorts = new Set<number>();
    const occupiedPorts = new Set<number>();
    const loggedConflictPorts = new Set<number>();
    const zombieReapedPorts = new Set<number>();
    const portDiagnoses = new Map<number, SyncListenerPortDiagnosis>();
    const diagnosePort = async (
      port: number,
      refresh = false,
    ): Promise<SyncListenerPortDiagnosis> => {
      if (!refresh) {
        const cached = portDiagnoses.get(port);
        if (cached) return cached;
      }
      const diagnosis = await inspectPort(port);
      portDiagnoses.set(port, diagnosis);
      return diagnosis;
    };
    for (let attemptIndex = 0; attemptIndex < attemptPlan.length; attemptIndex += 1) {
      const attemptedPort = attemptPlan[attemptIndex]!;
      if (isClosed()) throw new Error("The shared sync listener has been closed.");
      if (attemptedPort !== 0 && shadowedPorts.has(attemptedPort)) continue;
      if (attemptedPort !== 0 && occupiedPorts.has(attemptedPort)) continue;
      // The retry delay lets a dying listener free a FIXED port; an ephemeral
      // re-bind gets a fresh port immediately, so skip the delay for port 0.
      if (previousAttemptedPort === attemptedPort && attemptedPort !== 0) {
        await new Promise((resolve) => setTimeout(resolve, PREFERRED_PORT_BIND_RETRY_DELAY_MS));
      }
      previousAttemptedPort = attemptedPort;
      const { httpServer: candidateHttpServer, wsServer: candidateServer } = createServerPair();
      candidateHttpServer.listen(attemptedPort, bindHost);
      try {
        const resolvedPort = await new Promise<number>((resolve, reject) => {
          const onListening = async () => {
            const address = candidateServer.address();
            const port = typeof address === "object" && address ? address.port : attemptedPort;
            try {
              try {
                // A move (back to 8787, or off a shadowed port) probes its
                // candidate without recording the verdict: a candidate that
                // fails must not overwrite the status of the port still in
                // use. The winner's status is recorded once it is live.
                if (recordCandidateStatus) {
                  await validateLoopback(port);
                } else {
                  await assertLoopback(port);
                }
              } catch (error) {
                // A wildcard startup bind whose loopback another program
                // shadows still serves LAN and relay on this port; the
                // self-check opens a local side door for Tailscale. Staying
                // keeps the port phones already know. A move never does this.
                if (!bindOptions.migrate && !bindsLoopbackOnly && isLoopbackShadowedError(error)) {
                  cleanup();
                  resolve(port);
                  return;
                }
                throw error;
              }
              // LAN peers must reach this server on the port too: another
              // program on <lan-ip>:<port> would answer them instead. Without
              // this, a move back to a port still shadowed on the LAN would
              // flip back and forth every check.
              const lanShadow = await findShadowedLocalAddress(port);
              if (lanShadow) {
                throw new LoopbackShadowedError(port, `Another program answers on ${lanShadow}:${port}, not ADE.`);
              }
              cleanup();
              resolve(port);
            } catch (error) {
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          const onError = (error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          const handleListening = () => {
            void onListening();
          };
          const cleanup = () => {
            candidateServer.off("listening", handleListening);
            candidateServer.off("error", onError);
          };
          candidateServer.on("listening", handleListening);
          candidateServer.on("error", onError);
        });
        // Shutdown won the race with this bind: the catch below closes it.
        if (isClosed()) throw new Error("The shared sync listener has been closed.");
        deps.onBound(candidateServer, candidateHttpServer, resolvedPort);
        if (!recordCandidateStatus) deps.recordMoveWinner(resolvedPort);
        return resolvedPort;
      } catch (error) {
        lastError = error;
        await closeCandidateServer(candidateServer, candidateHttpServer);
        // A normal shutdown, not a bind failure: nothing to classify or log.
        if (isClosed()) throw error;
        // Record the RESOLVED port (not the literal 0) so an ephemeral shadow
        // does not poison the remaining fresh-port re-binds.
        if (isLoopbackShadowedError(error)) {
          shadowedPorts.add(attemptedPort === 0 ? error.port : attemptedPort);
        }
        const retryable = isRetryableListenerBindError(error)
          && (attemptedPort !== 0 || isLoopbackShadowedError(error));
        let diagnosis: SyncListenerPortDiagnosis | null = null;
        let reapedStaleHolder = false;
        if (
          (error as NodeJS.ErrnoException | null | undefined)?.code === "EADDRINUSE"
          && attemptedPort > 0
          && !zombieReapedPorts.has(attemptedPort)
        ) {
          diagnosis = await diagnosePort(attemptedPort);
          const staleHolder = attemptedPort >= DEFAULT_SYNC_HOST_PORT
            && attemptedPort <= SYNC_HOST_MAX_PORT
            ? findStaleHolder(diagnosis)
            : null;
          if (staleHolder) {
            // Reconfirm ownership immediately before signaling. The original
            // holder may have exited and its pid may have been reused while
            // the first lsof/ps diagnosis was being assembled.
            const confirmedHolder = findStaleHolder(await diagnosePort(attemptedPort, true));
            if (
              staleHolder.startTime != null
              && confirmedHolder?.pid === staleHolder.pid
              && confirmedHolder.startTime === staleHolder.startTime
            ) {
              zombieReapedPorts.add(attemptedPort);
              try {
                await terminatePid(staleHolder.pid);
                reapedStaleHolder = true;
              } catch (error) {
                // Not proven, or the kill did not take: the holder still owns the port.
                logger.warn?.("sync_listener.zombie_not_reaped", {
                  port: attemptedPort,
                  pid: staleHolder.pid,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              if (reapedStaleHolder) {
                logger.info?.("sync_listener.zombie_reaped", {
                  port: attemptedPort,
                  pid: staleHolder.pid,
                  servicePid: activeServicePid(),
                });
                // Non-preferred candidates occur only once in the normal plan.
                // Insert exactly one immediate retry for the newly-freed port.
                attemptPlan.splice(attemptIndex + 1, 0, attemptedPort);
              }
            }
          }
          // A confirmed live holder will not disappear during a 3.2 second
          // retry loop. Advance immediately to the next candidate instead of
          // fighting the desktop (or another runtime) and logging eight copies.
          if (!reapedStaleHolder && diagnosis.holders.length > 0) {
            occupiedPorts.add(attemptedPort);
          }
        }
        const event = isLoopbackShadowedError(error)
          ? "sync_listener.loopback_shadowed"
          : retryable ? "sync_listener.bind_port_conflict" : "sync_listener.bind_failed";
        if (event !== "sync_listener.bind_port_conflict" || !loggedConflictPorts.has(attemptedPort)) {
          if (event === "sync_listener.bind_port_conflict") loggedConflictPorts.add(attemptedPort);
          // A move retries on a timer (every 15 s back toward 8787), so its
          // expected misses stay at debug; the startup bind warns.
          const log = bindOptions.migrate && event !== "sync_listener.bind_failed"
            ? logger.debug
            : logger.warn;
          log?.(event, {
            attemptedPort,
            error: error instanceof Error ? error.message : String(error),
            code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
            ...(diagnosis ? { holderPids: diagnosis.holders.map((holder) => holder.pid) } : {}),
            retriesSkipped: occupiedPorts.has(attemptedPort)
              ? attemptPlan.slice(attemptIndex + 1).filter((port) => port === attemptedPort).length
              : 0,
          });
        }
        if (!retryable) throw error;
      }
    }
    const candidateDiagnosis = await Promise.all(
      [...new Set(candidates)]
        .filter((port) => port > 0)
        .slice(0, 5)
        .map((port) => diagnosePort(port)),
    );
    if (!bindOptions.migrate) {
      logger.warn?.("sync_listener.bind_exhausted", {
        candidates: candidateDiagnosis,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to bind the shared sync listener.");
  };

  return bindOnce;
}
