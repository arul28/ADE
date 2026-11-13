import http from "node:http";
import os from "node:os";
import { WebSocketServer } from "ws";
import { SYNC_PORT_SCAN_ABOVE } from "./syncProtocol";
import {
  assertAdeLoopbackListener,
  isLoopbackShadowedError,
  LoopbackShadowedError,
  probeAdeListenerAt,
  probeAdeLoopbackListener,
  programNameFromCommandLine,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";
import { closeCandidateServer, createListenerBinder } from "./syncListenerBind";
import {
  inspectSyncListenerPort,
  type SyncListenerPortDiagnosis,
} from "./syncListenerPortInspect";

/**
 * Where this brain's sync listener answers: which port it holds, the local-only
 * side door that keeps `127.0.0.1` reachable when another program shadows the
 * port, the self-check that repairs or moves either, and the verdicts that
 * describe them.
 *
 * This is one responsibility split out of the shared listener so the listener
 * keeps the sockets: identity nonce, connection dispatch, the peer parking lot,
 * the relay pipe handoff and attachment uploads. It injects the server factory
 * and the probes below; everything here stays transport-shaped, never
 * protocol-shaped.
 *
 * Bind policy — which port may be taken, and who already holds one — lives in
 * `syncListenerBind.ts`, next to the attempt plan it drives.
 */

type SyncListenerPortControllerLogger = {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type SharedSyncListenerPortChange = {
  from: number;
  to: number;
  reason: "loopback-shadowed" | "canonical";
};

/**
 * How often a listening shared listener re-checks that 127.0.0.1:<port> still
 * reaches it. Another program (a `wrangler dev`, any dev server) can take the
 * more specific loopback address on macOS and Windows while ADE holds the
 * wildcard, at any time after startup. One local HTTP request per interval.
 */
export const SYNC_LISTENER_SELF_HEAL_INTERVAL_MS = 30_000;
/** Ports above the shadowed one a self-heal move tries before an OS-assigned one. */
const SELF_HEAL_PORT_SCAN = SYNC_PORT_SCAN_ABOVE;

export type SyncListenerPortControllerDeps = {
  logger: SyncListenerPortControllerLogger;
  bindHost: string;
  /**
   * One http + WebSocket server pair, wired by the listener. It stays there
   * because the wiring is dispatch, parking, the Apple stream route and the
   * upload registry, not port selection.
   */
  createServerPair: () => { httpServer: http.Server; wsServer: WebSocketServer };
  expectedLoopbackNonce: string;
  /**
   * True while a project sync host owns new sockets. A listener that somebody
   * is moments away from using must not walk back to the canonical port.
   */
  hasConnectionHandler: () => boolean;
  loopbackProbe?: (port: number, expectedNonce: string, timeoutMs?: number) => Promise<SyncLoopbackProbeResult>;
  /**
   * This machine's own non-loopback addresses the self-check also probes
   * (default: every external IPv4 interface address). A program can bind
   * `<address>:<port>` over the wildcard just as it can loopback.
   */
  localAddresses?: () => string[];
  /** Identity probe against one local address; defaults to an HTTP 426 probe. */
  addressProbe?: (host: string, port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
  inspectPort?: (port: number) => SyncListenerPortDiagnosis | Promise<SyncListenerPortDiagnosis>;
  activeServicePid?: () => number | null;
  terminatePid?: (pid: number) => Promise<void>;
};

export type SyncListenerPortController = {
  /**
   * Bind the websocket server once. Subsequent calls return the existing
   * port — project switches never rebind, so connected peers survive them.
   */
  ensureListening(portCandidates: number[]): Promise<number>;
  /**
   * Bind `port` alongside the current listener, then close the old one.
   * Used to steal 8787 back after a dual-brain split left us on 8788.
   * Returns null when the target is still busy; the existing bind is kept.
   */
  tryMigrateToPort(port: number): Promise<number | null>;
  getPort(): number | null;
  /**
   * The port `127.0.0.1` reaches this listener on: its own port, or a
   * local-only side door when another program holds `127.0.0.1:<port>`.
   * Tailscale Serve forwards here. Null when neither answers as ADE.
   */
  getLoopbackPort(): number | null;
  isListening(): boolean;
  getLoopbackValidationStatus(): SyncLoopbackValidationStatus;
  /** Force-check that loopback still reaches this exact listener instance. */
  revalidateLoopback(): Promise<void>;
  /** Subscribe to successful initial and explicit loopback validations. */
  onLoopbackValidated(handler: () => void): () => void;
  /**
   * Subscribe to every loopback verdict change (validated → shadowed and
   * back). Route health and publication read the status on demand; this is
   * the nudge that makes them re-read it.
   */
  onLoopbackStatusChanged(handler: () => void): () => void;
  /**
   * Subscribe to port moves: a move off a port another program shadowed, or
   * back to the canonical port. Everything that advertises the port (Bonjour,
   * Tailscale Serve, the sync lease, the account directory) re-reads it.
   */
  onPortChanged(handler: (change: SharedSyncListenerPortChange) => void): () => void;
  /**
   * Check now that loopback still reaches this listener, and move to a free
   * port when another program took it. Also runs on its own every
   * {@link SYNC_LISTENER_SELF_HEAL_INTERVAL_MS} once listening.
   */
  healNow(): Promise<void>;
  /**
   * First half of final shutdown: mark the controller closed, stop the
   * self-check, forget every subscriber, and close the side door and any
   * retired servers. The listener terminates its parked peers between this
   * and {@link closeServer} so final shutdown keeps its original order.
   */
  closeEntrances(): Promise<void>;
  /**
   * Second half of final shutdown: terminate the live server's clients and
   * free its port. Safe when no server is live.
   */
  closeServer(): Promise<void>;
};

type RetiredServer = { wsServer: WebSocketServer; httpServer: http.Server };

/** This machine's external IPv4 addresses, skipping link-local ones. */
function defaultLocalAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].slice(0, 8);
}

export function createSyncListenerPortController(
  deps: SyncListenerPortControllerDeps,
): SyncListenerPortController {
  const logger = deps.logger;
  const bindHost = deps.bindHost;
  // The listener owns the server wiring and the connection handler; these are
  // the two seams this controller calls back through.
  const { createServerPair, hasConnectionHandler, expectedLoopbackNonce } = deps;
  // A loopback-only bind has no other address to keep serving: a shadow on
  // its port means moving. A wildcard bind keeps its port (see the side door).
  const bindsLoopbackOnly = ["127.0.0.1", "::1", "localhost"].includes(bindHost.trim().toLowerCase());
  const loopbackProbe = deps.loopbackProbe ?? probeAdeLoopbackListener;
  const localAddresses = deps.localAddresses ?? defaultLocalAddresses;
  const addressProbe = deps.addressProbe ?? probeAdeListenerAt;
  const inspectPort = deps.inspectPort ?? inspectSyncListenerPort;

  let server: WebSocketServer | null = null;
  // The http.Server fronting `server`. `ws` does not own/close an
  // externally-supplied server, so we track it to free the port on close.
  let httpServer: http.Server | null = null;
  let listeningPromise: Promise<number> | null = null;
  // Serializes changes to the live server (a move off a shadowed port, a move
  // back to the preferred port, and the self-check that decides on them), so
  // two moves can never both bind and leave one server untracked. Side-door
  // changes also happen outside it (revalidateLoopback); they stay safe
  // because each re-checks `closed`/the live port and assigns synchronously
  // once its probe returns. close() does not wait for it: every move re-checks
  // `closed` and closes what it bound.
  let moveLock: Promise<unknown> = Promise.resolve();
  let closed = false;
  const loopbackValidatedHandlers = new Set<() => void>();
  let loopbackValidationStatus: SyncLoopbackValidationStatus = {
    port: null,
    loopbackAdeValidated: false,
    lastFailureAt: null,
    reason: "The shared sync listener has not been validated yet.",
    lastSuccessAt: null,
  };
  const loopbackStatusChangedHandlers = new Set<() => void>();
  const portChangedHandlers = new Set<(change: SharedSyncListenerPortChange) => void>();
  // Servers this listener moved away from. They no longer accept connections,
  // but sockets already upgraded on them (and an upload still in flight on the
  // http server) stay up: a move must not drop a connected phone. Final
  // close() ends them.
  const retiredServers = new Set<RetiredServer>();
  let selfHealTimer: ReturnType<typeof setInterval> | null = null;
  let healInFlight: Promise<void> | null = null;
  // The port this listener prefers (the first candidate of its first bind,
  // normally 8787). After a move, the self-check returns here once it frees.
  let canonicalPort: number | null = null;
  // A local-only entrance on another port, open only while another program
  // holds 127.0.0.1:<port> over the wildcard bind. LAN peers and relay pipes
  // keep the public port; Tailscale Serve forwards here instead.
  let sideDoor: { port: number; httpServer: http.Server; wsServer: WebSocketServer } | null = null;

  /** Call every subscriber, from a snapshot; one that throws is logged, not fatal. */
  const emit = <T>(handlers: Iterable<(value: T) => void>, value: T, failureEvent: string): void => {
    for (const next of [...handlers]) {
      try {
        next(value);
      } catch (error) {
        logger.warn?.(failureEvent, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const notifyLoopbackValidated = (): void =>
    emit(loopbackValidatedHandlers, undefined, "sync_listener.validation_handler_failed");

  const notifyLoopbackStatusChanged = (): void =>
    emit(loopbackStatusChangedHandlers, undefined, "sync_listener.status_handler_failed");

  const setLoopbackValidationStatus = (next: SyncLoopbackValidationStatus): void => {
    const previous = loopbackValidationStatus;
    loopbackValidationStatus = next;
    if (
      previous.port !== next.port
      || previous.loopbackAdeValidated !== next.loopbackAdeValidated
      || (previous.shadowedBy ?? null) !== (next.shadowedBy ?? null)
      || (previous.loopbackPort ?? null) !== (next.loopbackPort ?? null)
    ) {
      notifyLoopbackStatusChanged();
    }
  };

  const validateLoopback = async (port: number): Promise<void> => {
    try {
      const result = await assertAdeLoopbackListener(
        port,
        expectedLoopbackNonce,
        loopbackProbe,
      );
      setLoopbackValidationStatus({
        port,
        loopbackAdeValidated: true,
        lastFailureAt: loopbackValidationStatus.lastFailureAt,
        reason: null,
        lastSuccessAt: result.checkedAt,
        shadowedBy: null,
        loopbackPort: port,
      });
    } catch (error) {
      if (isLoopbackShadowedError(error)) {
        setLoopbackValidationStatus({
          port,
          loopbackAdeValidated: false,
          lastFailureAt: error.failedAt,
          reason: error.message,
          lastSuccessAt: loopbackValidationStatus.lastSuccessAt,
          // Keep a name already found for this port until the next lookup.
          shadowedBy: loopbackValidationStatus.port === port
            ? loopbackValidationStatus.shadowedBy ?? null
            : null,
          loopbackPort: null,
        });
      }
      throw error;
    }
  };

  /** Name the other program holding `port`, for the user; best effort, never throws. */
  const nameShadowHolder = async (port: number): Promise<string | null> => {
    try {
      const diagnosis = await inspectPort(port);
      const other = diagnosis.holders.find((holder) => holder.pid !== process.pid);
      return programNameFromCommandLine(other?.command ?? null);
    } catch {
      return null;
    }
  };

  // Stop accepting on a server we are moving away from without dropping the
  // sockets already upgraded on it. `ws` leaves an external server's clients
  // alone on close(); closing the http server only frees the port.
  const retireServer = (oldServer: WebSocketServer, oldHttp: http.Server): void => {
    if (closed) {
      // close() already swept the retired servers; end this one now.
      void closeCandidateServer(oldServer, oldHttp);
      return;
    }
    const entry = { wsServer: oldServer, httpServer: oldHttp };
    let httpClosed = false;
    const forget = (): void => {
      if (httpClosed && oldServer.clients.size === 0) retiredServers.delete(entry);
    };
    retiredServers.add(entry);
    try {
      oldServer.close();
    } catch {
      // ignore
    }
    try {
      oldHttp.close(() => {
        httpClosed = true;
        forget();
      });
      oldHttp.closeIdleConnections?.();
    } catch {
      httpClosed = true;
    }
    for (const client of oldServer.clients) client.once("close", forget);
    forget();
  };

  const withMoveLock = <T>(work: () => Promise<T>): Promise<T> => {
    const run = moveLock.then(work, work);
    moveLock = run.catch(() => undefined);
    return run;
  };

  const notifyPortChanged = (change: SharedSyncListenerPortChange): void =>
    emit(portChangedHandlers, change, "sync_listener.port_change_handler_failed");

  // Bind policy (which port may be taken, who already holds one) lives in its
  // own module. Everything here that a bind touches is a closure over the
  // controller's state, so a server that binds is adopted synchronously.
  const bindOnce = createListenerBinder({
    logger,
    bindHost,
    bindsLoopbackOnly,
    createServerPair,
    isClosed: () => closed,
    validateLoopback,
    assertLoopback: (port) => assertAdeLoopbackListener(port, expectedLoopbackNonce, loopbackProbe),
    findShadowedLocalAddress: (port) => findShadowedLocalAddress(port),
    inspectPort,
    activeServicePid: deps.activeServicePid,
    terminatePid: deps.terminatePid,
    onBound: (nextServer, nextHttpServer, port, { recordedStatus }) => {
      // The assignment is synchronous inside the bind, right after its
      // `closed` re-check: shutdown can never observe a bound server that
      // nothing tracks.
      server = nextServer;
      httpServer = nextHttpServer;
      if (!recordedStatus) {
        // A move's winner validated during its bind; record it now that it
        // is the live server, so every reader sees port and verdict agree.
        setLoopbackValidationStatus({
          port,
          loopbackAdeValidated: true,
          lastFailureAt: loopbackValidationStatus.lastFailureAt,
          reason: null,
          lastSuccessAt: new Date().toISOString(),
          shadowedBy: null,
          loopbackPort: port,
        });
      }
      nextServer.on("error", (error: unknown) => {
        logger.warn?.("sync_listener.server_error", {
          error: error instanceof Error ? error.message : String(error),
          code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
          port,
        });
      });
    },
  });

  /** The ports a move or side door tries: the few above `port`, then an OS-assigned one. */
  const portScanFrom = (port: number): number[] => {
    const candidates: number[] = [];
    for (let offset = 1; offset <= SELF_HEAL_PORT_SCAN && port + offset <= 65_535; offset += 1) {
      candidates.push(port + offset);
    }
    candidates.push(0);
    return candidates;
  };

  const currentPort = (): number | null => {
    const address = server?.address();
    return typeof address === "object" && address ? address.port : null;
  };

  /**
   * Move to a port whose loopback answers as this listener. Tries the ports
   * just above the shadowed one, then an OS-assigned port, which nothing can
   * be squatting. Connected sockets stay up through the move.
   */
  const moveOffShadowedPort = async (shadowedPort: number): Promise<number | null> => {
    const candidates = portScanFrom(shadowedPort);
    const previousServer = server;
    const previousHttp = httpServer;
    if (!previousServer || !previousHttp) return null;
    let nextPort: number;
    try {
      nextPort = await bindOnce(candidates, { migrate: true });
    } catch (error) {
      // bindOnce leaves `server` untouched when nothing bound.
      logger.warn?.("sync_listener.self_heal_move_failed", {
        from: shadowedPort,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    listeningPromise = Promise.resolve(nextPort);
    retireServer(previousServer, previousHttp);
    closeSideDoor();
    return nextPort;
  };

  /** Move to `port`. Call under the move lock. */
  const migrateToPortLocked = async (port: number): Promise<number | null> => {
    if (listeningPromise) await listeningPromise.catch(() => null);
    const fromPort = currentPort();
    if (closed || fromPort == null || server == null || httpServer == null) return null;
    const target = Math.max(1, Math.min(65_535, Math.floor(port)));
    if (fromPort === target) return fromPort;
    const previousServer = server;
    const previousHttp = httpServer;
    let nextPort: number;
    try {
      nextPort = await bindOnce([target], { migrate: true });
    } catch (error) {
      logger.debug?.("sync_listener.canonical_port_still_busy", {
        port: target,
        from: fromPort,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    listeningPromise = Promise.resolve(nextPort);
    // Connected phones keep their sockets; only new ones use the new port.
    retireServer(previousServer, previousHttp);
    closeSideDoor();
    logger.info?.("sync_listener.migrated_to_canonical_port", { from: fromPort, to: nextPort });
    notifyLoopbackValidated();
    // Everything that advertises the port follows it through this one event,
    // whoever asked for the move.
    notifyPortChanged({ from: fromPort, to: nextPort, reason: "canonical" });
    return nextPort;
  };

  /**
   * The first of this machine's own addresses where another program, not this
   * listener, answers on `port`; null when every one answers as ADE. Only a
   * foreign answer counts: a timeout or refusal on some interface (a VPN, a
   * firewall) says nothing about who owns the port and must never move it.
   */
  const findShadowedLocalAddress = async (port: number): Promise<string | null> => {
    // A loopback-only bind serves no other address to shadow.
    if (bindsLoopbackOnly) return null;
    let addresses: string[];
    try {
      addresses = localAddresses();
    } catch {
      return null;
    }
    // In parallel: one probe's deadline bounds the whole check, however many
    // interfaces there are.
    const results = await Promise.all(addresses.map(async (host) => {
      try {
        const result = await addressProbe(host, port, expectedLoopbackNonce);
        return !result.ok && result.statusCode != null ? host : null;
      } catch {
        return null;
      }
    }));
    if (closed) return null;
    return results.find((host): host is string => host != null) ?? null;
  };

  /**
   * Back to the preferred port once nothing holds it. A brain hosting a
   * project also does this from its sync service; doing it here covers a brain
   * with no project. Called under the move lock.
   */
  const returnToCanonicalPort = async (port: number): Promise<void> => {
    if (canonicalPort == null || port === canonicalPort || hasConnectionHandler() || closed) return;
    await migrateToPortLocked(canonicalPort).catch(() => null);
  };

  const closeSideDoor = (): void => {
    const door = sideDoor;
    if (!door) return;
    sideDoor = null;
    // Tailscale peers already on it keep their sockets until they close.
    retireServer(door.wsServer, door.httpServer);
    logger.info?.("sync_listener.loopback_side_door_closed", { port: door.port });
  };

  /**
   * A local-only entrance on a free port, answering exactly like the main
   * listener. Nothing else can hold the exact 127.0.0.1:<port> it binds, and
   * it is validated with the same identity probe before it is used.
   */
  const openSideDoor = async (mainPort: number): Promise<number | null> => {
    if (sideDoor) {
      // Re-check the open door each time; one that stopped answering as ADE
      // is replaced, never trusted.
      try {
        await assertAdeLoopbackListener(sideDoor.port, expectedLoopbackNonce, loopbackProbe);
        return sideDoor.port;
      } catch {
        closeSideDoor();
      }
    }
    let lastError: unknown = null;
    // Only the few ports above the main one, never an OS-assigned port: a
    // stale Tailscale entry left by a crash is recognised by that shape
    // (adeLoopbackForwardPort). With none free, the port itself moves.
    for (const candidate of portScanFrom(mainPort).filter((candidatePort) => candidatePort !== 0)) {
      if (closed) return null;
      const pair = createServerPair();
      // `ws` re-emits the http server's errors (EADDRINUSE on a taken
      // candidate) on the WebSocketServer; with no listener there, that
      // would throw out of the process instead of trying the next port.
      let doorOpen = false;
      pair.wsServer.on("error", (error: unknown) => {
        if (!doorOpen) return;
        logger.warn?.("sync_listener.server_error", {
          error: error instanceof Error ? error.message : String(error),
          port: candidate,
          sideDoor: true,
        });
      });
      try {
        const port = await new Promise<number>((resolve, reject) => {
          pair.httpServer.once("error", reject);
          pair.httpServer.listen(candidate, "127.0.0.1", () => {
            pair.httpServer.off("error", reject);
            const address = pair.httpServer.address();
            resolve(typeof address === "object" && address ? address.port : candidate);
          });
        });
        await assertAdeLoopbackListener(port, expectedLoopbackNonce, loopbackProbe);
        if (closed || sideDoor) {
          await closeCandidateServer(pair.wsServer, pair.httpServer);
          return sideDoor?.port ?? null;
        }
        doorOpen = true;
        sideDoor = { port, httpServer: pair.httpServer, wsServer: pair.wsServer };
        return port;
      } catch (error) {
        lastError = error;
        logger.debug?.("sync_listener.loopback_side_door_candidate_failed", {
          port: candidate,
          error: error instanceof Error ? error.message : String(error),
        });
        await closeCandidateServer(pair.wsServer, pair.httpServer);
      }
    }
    logger.warn?.("sync_listener.loopback_side_door_failed", {
      mainPort,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return null;
  };

  /**
   * Make sure 127.0.0.1 reaches this listener: on its own port when nothing
   * shadows it, else through the side door. Records the verdict. Returns
   * false only when no local route answers as ADE (a loopback-only bind that
   * is shadowed, or a side door that could not open); the caller moves then.
   */
  const ensureLocalRoute = async (port: number): Promise<boolean> => {
    // Probe before recording: while the side door serves, a shadowed main
    // port is the expected state, and writing "not validated" for a moment on
    // every check would make Tailscale unpublish and republish each time.
    let shadow: LoopbackShadowedError;
    try {
      const result = await assertAdeLoopbackListener(port, expectedLoopbackNonce, loopbackProbe);
      // A verdict about a port that is no longer live describes nothing.
      if (closed || currentPort() !== port) return false;
      setLoopbackValidationStatus({
        port,
        loopbackAdeValidated: true,
        lastFailureAt: loopbackValidationStatus.lastFailureAt,
        reason: null,
        lastSuccessAt: result.checkedAt,
        shadowedBy: null,
        loopbackPort: port,
      });
      closeSideDoor();
      return true;
    } catch (error) {
      if (!isLoopbackShadowedError(error)) throw error;
      shadow = error as LoopbackShadowedError;
    }
    const recordNoRoute = (holder: string | null): false => {
      setLoopbackValidationStatus({
        port,
        loopbackAdeValidated: false,
        lastFailureAt: shadow.failedAt,
        reason: shadow.message,
        lastSuccessAt: loopbackValidationStatus.lastSuccessAt,
        shadowedBy: holder,
        loopbackPort: null,
      });
      return false;
    };
    const holder = loopbackValidationStatus.port === port && loopbackValidationStatus.shadowedBy
      ? loopbackValidationStatus.shadowedBy
      : await nameShadowHolder(port);
    if (closed || currentPort() !== port) return false;
    if (bindsLoopbackOnly) return recordNoRoute(holder);
    const hadDoor = sideDoor != null;
    const doorPort = await openSideDoor(port);
    if (closed || currentPort() !== port) {
      // A door this call opened for a port that is no longer live serves
      // nothing; a move closes doors it sees, but this one opened after it.
      if (!hadDoor) closeSideDoor();
      return false;
    }
    if (doorPort == null) return recordNoRoute(holder);
    const shadowReason = shadow.message;
    if (!hadDoor) {
      logger.warn?.("sync_listener.loopback_side_door_opened", {
        port,
        sideDoorPort: doorPort,
        holder,
        reason: shadowReason,
      });
    }
    setLoopbackValidationStatus({
      port,
      loopbackAdeValidated: true,
      lastFailureAt: loopbackValidationStatus.lastFailureAt,
      reason: null,
      lastSuccessAt: new Date().toISOString(),
      shadowedBy: holder,
      loopbackPort: doorPort,
    });
    return true;
  };

  /** One self-check. Call under the move lock. */
  const runSelfHeal = async (): Promise<void> => {
    if (closed || !server) return;
    const port = currentPort();
    if (port == null) return;
    const wasValidated = loopbackValidationStatus.port === port
      && loopbackValidationStatus.loopbackAdeValidated;
    let shadowedAddress = "127.0.0.1";
    if (await ensureLocalRoute(port)) {
      if (!wasValidated) notifyLoopbackValidated();
      if (closed || currentPort() !== port) return;
      const lanShadow = await findShadowedLocalAddress(port);
      if (lanShadow == null) {
        await returnToCanonicalPort(port);
        return;
      }
      shadowedAddress = lanShadow;
    }
    if (closed || currentPort() !== port) return;
    // No local route, or another program answers LAN peers on this port: the
    // public port itself has to move. Name who holds it (for the user).
    const holder = await nameShadowHolder(port);
    if (closed || currentPort() !== port) return;
    if (holder && loopbackValidationStatus.port === port && !loopbackValidationStatus.loopbackAdeValidated) {
      setLoopbackValidationStatus({ ...loopbackValidationStatus, shadowedBy: holder });
    }
    logger.warn?.("sync_listener.loopback_shadowed_at_runtime", {
      port,
      address: shadowedAddress,
      holder,
      reason: shadowedAddress === "127.0.0.1" ? loopbackValidationStatus.reason : null,
    });
    const nextPort = await moveOffShadowedPort(port);
    if (nextPort == null || nextPort === port || closed) return;
    logger.warn?.("sync_listener.moved_off_shadowed_port", { from: port, to: nextPort, holder });
    // The new port validated during the bind; tell the bridge and hosts.
    notifyLoopbackValidated();
    notifyPortChanged({ from: port, to: nextPort, reason: "loopback-shadowed" });
  };

  const healNow = (): Promise<void> => {
    if (healInFlight) return healInFlight;
    const current = withMoveLock(runSelfHeal)
      .catch((error) => {
        logger.warn?.("sync_listener.self_heal_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (healInFlight === current) healInFlight = null;
      });
    healInFlight = current;
    return current;
  };

  const startSelfHealMonitor = (): void => {
    if (selfHealTimer || closed) return;
    selfHealTimer = setInterval(() => {
      void healNow();
    }, SYNC_LISTENER_SELF_HEAL_INTERVAL_MS);
    selfHealTimer.unref?.();
  };

  return {
    async ensureListening(portCandidates: number[]): Promise<number> {
      if (closed) throw new Error("The shared sync listener has been closed.");
      if (canonicalPort == null) {
        const first = portCandidates[0];
        canonicalPort = typeof first === "number" && first > 0 ? first : null;
      }
      if (!listeningPromise) {
        listeningPromise = bindOnce(portCandidates).catch((error) => {
          // A failed bind must not poison future attempts.
          listeningPromise = null;
          throw error;
        });
      }
      const port = await listeningPromise;
      startSelfHealMonitor();
      if (loopbackValidationStatus.port === port && loopbackValidationStatus.loopbackAdeValidated) {
        notifyLoopbackValidated();
      } else {
        // Serving degraded (every candidate was shadowed): look again now
        // rather than a full interval from now.
        void healNow();
      }
      return port;
    },

    async tryMigrateToPort(port: number): Promise<number | null> {
      if (closed) return null;
      return withMoveLock(() => migrateToPortLocked(port));
    },

    getPort: currentPort,

    getLoopbackPort(): number | null {
      const port = currentPort();
      if (port == null) return null;
      if (loopbackValidationStatus.port !== port || !loopbackValidationStatus.loopbackAdeValidated) return null;
      return loopbackValidationStatus.loopbackPort ?? null;
    },

    isListening(): boolean {
      return server?.address() != null;
    },

    getLoopbackValidationStatus(): SyncLoopbackValidationStatus {
      return { ...loopbackValidationStatus };
    },

    async revalidateLoopback(): Promise<void> {
      // Not under the move lock: a host attach must not wait out a slow
      // self-check. A move that lands meanwhile makes ensureLocalRoute report
      // a stale port, so check the new one once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const port = currentPort();
        if (port == null) throw new Error("The shared sync listener is not listening.");
        if (await ensureLocalRoute(port)) {
          notifyLoopbackValidated();
          return;
        }
        if (closed || currentPort() === port) {
          throw new LoopbackShadowedError(
            port,
            loopbackValidationStatus.reason ?? `127.0.0.1:${port} did not answer as ADE.`,
            loopbackValidationStatus.lastFailureAt ?? undefined,
          );
        }
      }
      throw new LoopbackShadowedError(
        currentPort() ?? 0,
        "The ADE sync listener moved twice while it was being checked.",
      );
    },

    onLoopbackValidated(nextHandler: () => void): () => void {
      loopbackValidatedHandlers.add(nextHandler);
      return () => {
        loopbackValidatedHandlers.delete(nextHandler);
      };
    },

    onLoopbackStatusChanged(nextHandler: () => void): () => void {
      loopbackStatusChangedHandlers.add(nextHandler);
      return () => {
        loopbackStatusChangedHandlers.delete(nextHandler);
      };
    },

    onPortChanged(nextHandler: (change: SharedSyncListenerPortChange) => void): () => void {
      portChangedHandlers.add(nextHandler);
      return () => {
        portChangedHandlers.delete(nextHandler);
      };
    },

    healNow,

    async closeEntrances(): Promise<void> {
      if (closed) return;
      closed = true;
      if (selfHealTimer) {
        clearInterval(selfHealTimer);
        selfHealTimer = null;
      }
      loopbackValidatedHandlers.clear();
      loopbackStatusChangedHandlers.clear();
      portChangedHandlers.clear();
      // Not waiting for a move in flight: a move or side door that finishes
      // after this point sees `closed` and closes what it bound.
      const door = sideDoor;
      sideDoor = null;
      if (door) await closeCandidateServer(door.wsServer, door.httpServer);
      for (const retired of [...retiredServers]) {
        retiredServers.delete(retired);
        await closeCandidateServer(retired.wsServer, retired.httpServer);
      }
      if (listeningPromise) {
        await listeningPromise.catch(() => {});
      }
    },

    async closeServer(): Promise<void> {
      const current = server;
      const currentHttp = httpServer;
      server = null;
      httpServer = null;
      if (!current) return;
      // Force-terminate every client. ws's close() for an EXTERNALLY-supplied
      // http server resolves only after every client socket drains, so a single
      // wedged socket would hang final shutdown; terminate side-steps that.
      for (const ws of current.clients) {
        try {
          ws.terminate();
        } catch {
          // ignore close failures
        }
      }
      try {
        // Detach ws's listeners from the http server (external server: this does
        // NOT close the http server, so we close it ourselves below).
        current.close();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        if (!currentHttp || !currentHttp.listening) {
          resolve();
          return;
        }
        try {
          currentHttp.close(() => resolve());
          // Force any lingering upgraded/keep-alive sockets so close() cannot hang.
          currentHttp.closeAllConnections?.();
        } catch {
          resolve();
        }
      });
    },
  };
}
