import { timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type {
  SyncApplicationCompressionCodec,
  SyncCommandPayload,
  SyncHelloAuth,
  SyncHelloErrorPayload,
  SyncHelloPayload,
} from "../../../../desktop/src/shared/types";
import { laneShareRightsEnded, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import {
  LANE_SHARE_GUEST_COMMANDS,
  LANE_SHARE_MAX_DEVICES_PER_GRANT,
  type LaneShareGuestRole,
} from "./laneShareGuestPolicy";
import {
  activeLaneShareGrantsFor,
  LaneShareGrantError,
  type LaneShareGrantSource,
} from "./laneShareGrantService";
import { evaluatePairedHelloDpop, syncDpopFailureMessage, syncDpopKeyThumbprint, type createSyncDpopNonceCache } from "./syncDpop";
import { SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE } from "./syncAccountHelloAuth";
import { SYNC_PEER_ROLE_ROSTER } from "./syncHelloProtocol";
import { reportHelloRejected, reportPeerAccepted } from "./syncHelloTelemetry";
import { SYNC_CHUNKED_ENVELOPES_CAPABILITY } from "./syncProtocol";
import type { LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import {
  LANE_SHARE_NO_GRANT,
  LANE_SHARE_PROJECT_NOT_OPEN,
  LANE_SHARE_UNAVAILABLE,
  type LaneShareGuestHandoff,
  type LaneShareGuestHostDeps,
  type LaneShareGuestPeer,
  type LaneShareRedeemedGuest,
} from "./laneShareGuestTypes";

/** What the owner's machine list calls a guest. Host-made: never the name the guest sent. */
function laneShareGuestLabel(userId: string): string {
  const short = userId.replace(/^user_/, "").slice(0, 6);
  return short ? `Guest ${short}` : "Guest";
}

/** The guest host's state the hello reads and writes (`laneShareGuestHost.ts`). */
export type LaneShareGuestHelloDeps = LaneShareGuestHostDeps & {
  host: {
    laneShareRights: LaneShareRightsStore | null;
    laneShareGuestPeersBySocket: Map<WebSocket, LaneShareGuestPeer>;
    laneShareGuestDpopNonceCache: ReturnType<typeof createSyncDpopNonceCache>;
    claimLaneShareRedeem(ticket: string): "ok" | "seen" | "busy";
    emitLaneSharePresence(role: LaneShareGuestRole): void;
    enforceLaneShareGrantAge(): void;
    laneShareConnectedDevices(grantId: string): number;
    laneShareLaneState(laneId: string | null | undefined): "active" | "archived" | "missing";
    laneShareOpaqueHostId(deviceId: string, grantId: string): string;
    laneSharePairId(prefix: string, a: string, b: string): string;
    laneShareRightsFor(grantId: string): LaneShareRights | null;
    laneShareRightsMatchLane(grantId: string, laneId: string): boolean;
    syncLaneShareRefreshTimer(): void;
  };
};

/**
 * The guest hello of a sync host: refusals, the ticket redeem, the hand-off
 * to the lane's project (`laneShareGuestRouter.ts`), and the admission of a
 * redeemed guest. The guest host (`laneShareGuestHost.ts`) holds the state.
 */
export function createLaneShareGuestHello(deps: LaneShareGuestHelloDeps) {
  const {
    args,
    send,
    remoteCommandService,
    readBrainMetadata,
    captureAccountAuthorization,
    isPeerLifecycleCurrent,
    clearPeerAuthTimeout,
    heartbeatIntervalMs,
    pollIntervalMs,
    compressionThresholdBytes,
    buildSyncHostHelloOkPayload,
  } = deps;
  const {
    laneShareRights,
    laneShareGuestPeersBySocket,
    laneShareGuestDpopNonceCache,
    claimLaneShareRedeem,
    emitLaneSharePresence,
    enforceLaneShareGrantAge,
    laneShareConnectedDevices,
    laneShareLaneState,
    laneShareOpaqueHostId,
    laneSharePairId,
    laneShareRightsFor,
    laneShareRightsMatchLane,
    syncLaneShareRefreshTimer,
  } = deps.host;

  /** A refused guest hello: logged, answered with its code and reason, and the socket closed. */
  function refuseLaneShareGuest(
    peer: LaneShareGuestPeer,
    requestId: string | null,
    hello: SyncHelloPayload,
    code: Exclude<SyncHelloErrorPayload["code"], "protocol_version_mismatch">,
    message: string,
    logReason: string,
  ): void {
    args.logger.warn("sync_host.lane_share_guest_refused", {
      reason: logReason,
      transportOrigin: peer.transportOrigin,
      remoteAddress: peer.remoteAddress,
    });
    reportHelloRejected(
      { logger: args.logger, hello, transportOrigin: peer.transportOrigin, hostDeviceId: () => readBrainMetadata().deviceId },
      code,
    );
    send(peer.ws, "hello_error", { code, message } satisfies SyncHelloErrorPayload, requestId);
    try {
      peer.ws.close(4003, "Authentication failed");
    } catch {
      // ignore close failures
    }
  }

  /**
   * The guest hello. Order: relay only, device id, grant source, a DPoP proof
   * over the ticket (all local, so a hello without a well-formed ticket and a
   * valid proof never reaches the directory), host signed in, the ticket
   * redeemed by the directory with the owner's token, the proof's key equal
   * to the key the ticket was minted for, a guest that is not the owner, the
   * ticket's grant active in the list read with it, and the host account
   * unchanged across all of it. Nothing the client sends decides an account,
   * a role or a lane.
   */
  async function handleLaneShareGuestHello(
    peer: LaneShareGuestPeer,
    requestId: string | null,
    hello: SyncHelloPayload,
    auth: Extract<SyncHelloAuth, { kind: "guest" }>,
    lifecycleGeneration: number,
    negotiatedCompression: SyncApplicationCompressionCodec | null,
  ): Promise<void> {
    const refuse = (
      code: Exclude<SyncHelloErrorPayload["code"], "protocol_version_mismatch">,
      message: string,
      logReason: string,
    ): void => refuseLaneShareGuest(peer, requestId, hello, code, message, logReason);
    if (peer.transportOrigin !== "relay-bridge") {
      refuse("lane_share_refused", "A shared lane is reachable only through ADE Relay.", "not_relay");
      return;
    }
    if (auth.deviceId !== hello.peer.deviceId) {
      refuse("invalid_hello", "Invalid hello payload.", "device_mismatch");
      return;
    }
    const grantSource = args.laneShareGrants;
    if (!grantSource) {
      refuse("lane_share_unavailable", LANE_SHARE_UNAVAILABLE, "no_grant_source");
      return;
    }
    // The proof signs the ticket, so a ticket copied off the wire is useless
    // without the guest's private key. Checked before any network call.
    let dpopPublicKey: string | null = null;
    const dpopFailure = evaluatePairedHelloDpop({
      storedPublicKey: null,
      deviceId: auth.deviceId,
      secret: auth.ticket,
      proof: auth.dpop ?? null,
      requireDpop: true,
      nonceCache: laneShareGuestDpopNonceCache,
      adoptPublicKey: (publicKey) => {
        dpopPublicKey = publicKey;
      },
    });
    const proofThumbprint = dpopPublicKey ? syncDpopKeyThumbprint(dpopPublicKey) : null;
    if (dpopFailure || !dpopPublicKey || !proofThumbprint) {
      refuse("auth_failed", syncDpopFailureMessage(dpopFailure ?? "dpop_required"), `dpop_${dpopFailure ?? "missing"}`);
      return;
    }
    const claim = claimLaneShareRedeem(auth.ticket);
    if (claim === "seen") {
      refuse("lane_share_refused", LANE_SHARE_NO_GRANT, "ticket_seen");
      return;
    }
    if (claim === "busy") {
      refuse("lane_share_unavailable", LANE_SHARE_UNAVAILABLE, "redeem_rate");
      return;
    }
    const before = await captureAccountAuthorization();
    if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
    if (!before) {
      refuse("lane_share_unavailable", LANE_SHARE_UNAVAILABLE, "host_signed_out");
      return;
    }
    let redeemed: Awaited<ReturnType<LaneShareGrantSource["redeem"]>>;
    try {
      redeemed = await grantSource.redeem(auth.ticket);
    } catch (error) {
      if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      const code = error instanceof LaneShareGrantError ? error.code : "unavailable";
      // A ticket the directory does not honor, or a machine it does not list
      // for this account: no grant. Anything else: could not decide.
      if (code === "ticket_refused" || code === "unknown_machine") refuse("lane_share_refused", LANE_SHARE_NO_GRANT, `ticket_${code}`);
      else refuse("lane_share_unavailable", LANE_SHARE_UNAVAILABLE, `ticket_${code}`);
      return;
    }
    if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
    const { redemption, snapshot } = redeemed;
    // The ticket was minted for one key; a hello signed by any other is not its guest.
    const expected = Buffer.from(redemption.dpopThumbprint, "utf8");
    const presented = Buffer.from(proofThumbprint, "utf8");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      refuse("lane_share_refused", LANE_SHARE_NO_GRANT, "ticket_dpop_mismatch");
      return;
    }
    // A brain serves one project on its shared listener at a time. A lane of
    // another project is not in this host's database: the socket goes to that
    // project's host (`routeLaneShareGuest`), redeemed, never looked up here.
    const checkedHere = { dpopPublicKey, redemption, snapshot, redeemerUserId: before.userId };
    if (redemption.repoKey && redemption.repoKey !== (args.getLaneShareRepoKey?.() ?? null)) {
      await handOffLaneShareGuest(peer, requestId, hello, auth, checkedHere);
      return;
    }
    // The same repository, but not this checkout's lane (a second checkout of
    // it, or a grant with no repository key): another project may have it.
    if (laneShareLaneState(redemption.laneId) === "missing" && deps.routeLaneShareGuest) {
      await handOffLaneShareGuest(peer, requestId, hello, auth, checkedHere, { fallbackRefusal: "lane_missing" });
      return;
    }
    await admitRedeemedLaneShareGuest(peer, requestId, hello, auth, lifecycleGeneration, negotiatedCompression, {
      dpopPublicKey,
      redemption,
      snapshot,
      before,
    });
  }

  /**
   * A guest whose lane is in another project: this host lets go of the socket
   * and the brain's router gives it to that project's host. When no project
   * here can take it, the guest is told so and tries again later.
   */
  async function handOffLaneShareGuest(
    peer: LaneShareGuestPeer,
    requestId: string | null,
    hello: SyncHelloPayload,
    auth: Extract<SyncHelloAuth, { kind: "guest" }>,
    redeemed: LaneShareRedeemedGuest | null,
    options: { fallbackRefusal?: "lane_missing" } = {},
  ): Promise<void> {
    const refuseUnrouted = () => options.fallbackRefusal === "lane_missing"
      ? refuseLaneShareGuest(peer, requestId, hello, "lane_share_refused", LANE_SHARE_NO_GRANT, "lane_missing")
      : refuseLaneShareGuest(peer, requestId, hello, "lane_share_unavailable", LANE_SHARE_PROJECT_NOT_OPEN, "project_not_hosted");
    if (!deps.routeLaneShareGuest) {
      refuseUnrouted();
      return;
    }
    const handoff: LaneShareGuestHandoff = {
      ws: peer.ws,
      remoteAddress: peer.remoteAddress ?? null,
      remotePort: peer.remotePort ?? null,
      transportOrigin: peer.transportOrigin,
      requestId,
      hello,
      auth,
      redeemed,
      fromProjectId: args.projectId ?? null,
    };
    deps.releasePeerForHandoff(peer);
    let routed = false;
    try {
      routed = await deps.routeLaneShareGuest(handoff);
    } catch (error) {
      args.logger.warn("sync_host.lane_share_guest_route_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (routed) {
      args.logger.info("sync_host.lane_share_guest_routed", { redeemed: redeemed != null });
      return;
    }
    // Released, so answered on the bare socket.
    refuseUnrouted();
  }

  /**
   * A guest socket another host or the brain's ingress gave to this host.
   * Redeemed: the checks after the redeem run here. Not redeemed: the whole
   * hello runs here, as if the socket had landed on this host.
   */
  async function acceptHandedOffLaneShareGuest(
    peer: LaneShareGuestPeer,
    handoff: LaneShareGuestHandoff,
    lifecycleGeneration: number,
    negotiatedCompression: SyncApplicationCompressionCodec | null,
  ): Promise<void> {
    if (!handoff.redeemed) {
      await handleLaneShareGuestHello(peer, handoff.requestId, handoff.hello, handoff.auth, lifecycleGeneration, negotiatedCompression);
      return;
    }
    // A redeemed guest is not routed again: a project that does not match now
    // (its origin changed during the hop) refuses it.
    if (handoff.redeemed.redemption.repoKey && handoff.redeemed.redemption.repoKey !== (args.getLaneShareRepoKey?.() ?? null)) {
      refuseLaneShareGuest(
        peer,
        handoff.requestId,
        handoff.hello,
        "lane_share_unavailable",
        LANE_SHARE_PROJECT_NOT_OPEN,
        "project_not_hosted",
      );
      return;
    }
    const before = await captureAccountAuthorization();
    if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
    if (!before) {
      refuseLaneShareGuest(peer, handoff.requestId, handoff.hello, "lane_share_unavailable", LANE_SHARE_UNAVAILABLE, "host_signed_out");
      return;
    }
    // The ticket was redeemed with one account's token; a switch of the
    // owner's account during the hop leaves that grant behind.
    if (before.userId !== handoff.redeemed.redeemerUserId) {
      refuseLaneShareGuest(peer, handoff.requestId, handoff.hello, "account_session_changed", SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE, "host_account_changed");
      return;
    }
    await admitRedeemedLaneShareGuest(peer, handoff.requestId, handoff.hello, handoff.auth, lifecycleGeneration, negotiatedCompression, {
      ...handoff.redeemed,
      before,
    });
  }

  /**
   * The hello after the ticket was redeemed and its key checked: owner, grant,
   * lane, device count, account unchanged, rights; then the guest's role and
   * `hello_ok`.
   */
  async function admitRedeemedLaneShareGuest(
    peer: LaneShareGuestPeer,
    requestId: string | null,
    hello: SyncHelloPayload,
    auth: Extract<SyncHelloAuth, { kind: "guest" }>,
    lifecycleGeneration: number,
    negotiatedCompression: SyncApplicationCompressionCodec | null,
    checked: Omit<LaneShareRedeemedGuest, "redeemerUserId"> & { before: { userId: string; generation: number } },
  ): Promise<void> {
    const refuse = (
      code: Exclude<SyncHelloErrorPayload["code"], "protocol_version_mismatch">,
      message: string,
      logReason: string,
    ): void => refuseLaneShareGuest(peer, requestId, hello, code, message, logReason);
    const { dpopPublicKey, redemption, snapshot, before } = checked;
    // The account comes from the directory's answer, never from the hello.
    const guestUserId = redemption.receiverUserId;
    if (guestUserId === before.userId) {
      refuse("lane_share_refused", "This is your own computer. Connect with your account instead.", "owner_as_guest");
      return;
    }
    const grants = activeLaneShareGrantsFor(snapshot, guestUserId, Date.now())
      .filter((grant) => grant.grantId === redemption.grantId && grant.laneId === redemption.laneId);
    if (grants.length === 0) {
      refuse("lane_share_refused", LANE_SHARE_NO_GRANT, "no_active_grant");
      return;
    }
    const laneState = laneShareLaneState(redemption.laneId);
    if (laneState === "missing") {
      refuse("lane_share_refused", LANE_SHARE_NO_GRANT, "lane_missing");
      return;
    }
    if (laneState === "archived") {
      refuse("lane_share_paused", "The owner paused this shared lane.", "lane_paused");
      return;
    }
    if (laneShareConnectedDevices(redemption.grantId) >= LANE_SHARE_MAX_DEVICES_PER_GRANT) {
      refuse(
        "lane_share_refused",
        `This shared lane is open on ${LANE_SHARE_MAX_DEVICES_PER_GRANT} of your devices. Close it on one, then try again.`,
        "device_cap",
      );
      return;
    }
    const after = await captureAccountAuthorization();
    if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
    if (!after || after.userId !== before.userId || after.generation !== before.generation) {
      refuse("account_session_changed", SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE, "host_account_changed");
      return;
    }
    // Read after the last await: a revoke deletes the row first, and from then
    // on no hello may finish.
    const grantRights = laneShareRightsFor(redemption.grantId);
    const rightsMissing = "The owner has not set your access on this computer yet. Ask the owner to open the share.";
    if (!grantRights) {
      refuse("lane_share_paused", rightsMissing, "rights_missing");
      return;
    }
    // Rights are for one lane: the directory's grant must name that lane.
    if (!laneShareRightsMatchLane(redemption.grantId, redemption.laneId)) {
      refuse("lane_share_paused", rightsMissing, "rights_lane_mismatch");
      return;
    }
    if (laneShareRightsEnded(grantRights, Date.now())) {
      refuse("lane_share_refused", LANE_SHARE_NO_GRANT, "rights_ended");
      return;
    }

    const role: LaneShareGuestRole = {
      guest: true,
      userId: guestUserId,
      grantId: redemption.grantId,
      clientDeviceId: auth.deviceId,
      dpopPublicKey,
      grants,
      rights: grantRights,
      name: grants[0]?.receiverName ?? null,
      historyFallbackMs: (() => {
        try {
          return laneShareRights?.get(redemption.grantId)?.createdAt || Date.now();
        } catch {
          return Date.now();
        }
      })(),
      sessionLanes: new Map(),
      rate: { windowStartMs: 0, count: 0 },
    };
    // A device id the client chose must never key anything shared with the
    // owner's devices (presence, arbitration, the command cache, terminal
    // input dedupe), so a guest's peer id is derived and namespaced.
    const guestDeviceId = laneSharePairId("guest", guestUserId, auth.deviceId);
    const {
      connectionAttempt: _connectionAttempt,
      dbVersionBySite: _dbVersionBySite,
      connectionPurpose: _connectionPurpose,
      ...clientPeer
    } = hello.peer;
    peer.laneShareGuest = role;
    laneShareGuestPeersBySocket.set(peer.ws, peer);
    peer.authenticated = true;
    peer.helloAcceptedAtMs = Date.now();
    peer.adoptChallenge = null;
    clearPeerAuthTimeout(peer);
    // `roster`: never a replica. No changeset, cursor row or handoff. The
    // name is the host's, so the owner's machine list never shows a name the
    // guest chose (such as the owner's own phone).
    peer.metadata = {
      ...clientPeer,
      deviceId: guestDeviceId,
      deviceName: laneShareGuestLabel(guestUserId),
      syncRole: SYNC_PEER_ROLE_ROSTER,
    };
    peer.authKind = "guest";
    peer.pairedDeviceId = null;
    peer.pairingRecord = null;
    peer.pendingPairingCommitDeviceId = null;
    peer.pendingPairingCommitSecret = null;
    peer.lastKnownServerDbVersion = args.db.sync.getDbVersion();
    // No Relay lease: a guest sends no account token to refresh one. The
    // grant refresh and `enforceLaneShareGrantAge` bound the session instead.
    peer.relayAuthorization?.dispose();
    peer.relayAuthorization = null;
    const supported = new Set<string>(remoteCommandService.getSupportedActions());
    const guestActions = Object.keys(LANE_SHARE_GUEST_COMMANDS)
      .filter((action) => supported.has(action)) as SyncCommandPayload["action"][];
    const guestActionSet = new Set<string>(guestActions);
    const brain = readBrainMetadata();
    const { hostHealth: _hostHealth, ...helloOk } = buildSyncHostHelloOkPayload({
      peer: peer.metadata,
      // Only what names the computer. No site id, database version or app version.
      // Hidden machines: no name, platform, kind or device id. The id is a
      // stable one made for this share, so the guest still tells reconnects
      // to the same computer apart from another one.
      brain: role.rights.privacy.hideMachines
        ? {
          deviceId: laneShareOpaqueHostId(brain.deviceId, role.grantId),
          deviceName: "Shared computer",
          platform: "unknown",
          deviceType: "unknown",
          siteId: "",
          dbVersion: 0,
        }
        : {
          deviceId: brain.deviceId,
          deviceName: brain.deviceName,
          platform: brain.platform,
          deviceType: brain.deviceType,
          siteId: "",
          dbVersion: 0,
        },
      serverDbVersion: 0,
      heartbeatIntervalMs,
      pollIntervalMs,
      compression: negotiatedCompression,
      chunkedEnvelopes: hello.peer.capabilities?.includes(SYNC_CHUNKED_ENVELOPES_CAPABILITY) === true,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      rosterEnabled: false,
      remoteCommandSupportedActions: guestActions,
      remoteCommandDescriptors: remoteCommandService.getDescriptors().filter((entry) => guestActionSet.has(entry.action)),
      localCommandDescriptors: [],
      compressionThresholdBytes,
      relayAuthorization: null,
      connectionTransport: "relay",
      runtimeChannelEnabled: false,
      omitProjectCatalog: true,
      pipelinedHelloAccepted: 0,
    });
    const helloOkSent = send(peer.ws, "hello_ok", {
      ...helloOk,
      laneShareGuest: { userId: role.userId, grants: role.grants.map((grant) => ({ grantId: grant.grantId, laneId: grant.laneId })) },
    }, requestId);
    if (helloOkSent) {
      reportPeerAccepted({
        logger: args.logger,
        hello,
        transportOrigin: peer.transportOrigin,
        hostDeviceId: () => brain.deviceId,
      });
      args.logger.info("sync_host.lane_share_guest_accepted", {
        guestUserId: role.userId,
        grantCount: role.grants.length,
      });
      emitLaneSharePresence(role);
    }
    peer.negotiatedCompression = negotiatedCompression;
    syncLaneShareRefreshTimer();
  }

  return { handleLaneShareGuestHello, acceptHandedOffLaneShareGuest };
}
