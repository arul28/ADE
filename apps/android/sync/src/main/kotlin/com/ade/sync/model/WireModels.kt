package com.ade.sync.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val SYNC_PROTOCOL_VERSION = 1
const val SYNC_PROTOCOL_MIN_SUPPORTED = 1
const val SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY = "relayReauthorizeV1"
const val SYNC_INVALIDATION_ONLY_V1_CAPABILITY = "invalidationOnlyV1"
const val SYNC_COMPACT_INVALIDATION_V1_CAPABILITY = "compactInvalidationV1"
const val SYNC_CHUNKED_ENVELOPES_CAPABILITY = "chunkedEnvelopes"

val ANDROID_THIN_CAPABILITIES = listOf(
    SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
    SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
    SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
    SYNC_CHUNKED_ENVELOPES_CAPABILITY,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncEnvelope. */
@Serializable
data class SyncEnvelope(
    val version: Int = SYNC_PROTOCOL_VERSION,
    val type: String,
    val projectId: String? = null,
    val requestId: String? = null,
    val compression: String = "none",
    val payloadEncoding: String = "json",
    val payload: JsonElement,
    val uncompressedBytes: Int? = null,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncPeerMetadata. */
@Serializable
data class SyncPeerMetadata(
    val deviceId: String,
    val deviceName: String,
    val platform: String = "android",
    val deviceType: String = "phone",
    val siteId: String,
    val dbVersion: Long = 0,
    val dbVersionBySite: Map<String, Long>? = null,
    val connectionAttempt: ConnectionAttempt? = null,
    val capabilities: List<String> = ANDROID_THIN_CAPABILITIES,
    val appVersion: String? = null,
    val appBuild: String? = null,
    val bundleIdentifier: String? = null,
) {
    init {
        require("changesetAck" !in capabilities) {
            "Replica-free Android peers must never advertise changesetAck"
        }
    }
}

@Serializable
data class ConnectionAttempt(val id: String, val startedAtMs: Long)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncDpopProof. */
@Serializable
data class DpopProof(
    val algorithm: String = "p256-sha256",
    val publicKey: String,
    val timestamp: Long,
    val nonce: String,
    val signature: String,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncHelloPayload. */
@Serializable
data class HelloPayload(
    val peer: SyncPeerMetadata,
    val compression: List<String> = listOf("deflate"),
    val auth: JsonObject,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncHelloOkPayload. */
@Serializable
data class HelloOkPayload(
    val brain: SyncPeerMetadata? = null,
    val serverDbVersion: Long = 0,
    val serverDbSiteId: String? = null,
    val heartbeatIntervalMs: Long = 60_000,
    val pollIntervalMs: Long = 400,
    val compression: CompressionSelection? = null,
    val features: HelloFeatures = HelloFeatures(),
    val projects: List<MobileProject> = emptyList(),
    val cloudRelayWssUrl: String? = null,
    val connectionTransport: String? = null,
    val accountPairing: AccountPairing? = null,
    val relayAuthorization: RelayAuthorizationLease? = null,
)

@Serializable
data class AccountPairing(val deviceId: String, val secret: String)

@Serializable
data class RelayAuthorizationLease(
    val expiresAt: Long,
    val refreshAfter: Long,
    val challenge: String,
    val graceMs: Long,
)

@Serializable
data class CompressionSelection(val codec: String, val thresholdBytes: Int = 512)

@Serializable
data class EnabledFeature(val enabled: Boolean = false)

@Serializable
data class HelloFeatures(
    val invalidationOnlyV1: EnabledFeature? = null,
    val compactInvalidationV1: EnabledFeature? = null,
    val chunkedEnvelopes: ChunkedEnvelopeFeature? = null,
    val projectCatalog: EnabledFeature? = null,
    val projectActions: EnabledFeature? = null,
    val crossProjectChat: EnabledFeature? = null,
    val chatHistoryPaging: EnabledFeature? = null,
    val terminalInputAck: EnabledFeature? = null,
    val commandRouting: CommandRouting = CommandRouting(),
    val mobileCompatibility: MobileCompatibility? = null,
)

@Serializable
data class ChunkedEnvelopeFeature(val enabled: Boolean = false, val maxFrameBytes: Int? = null)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncRemoteCommandDescriptor. */
@Serializable
data class RemoteCommandDescriptor(
    val action: String,
    val scope: String = "project",
    val policy: RemoteCommandPolicy = RemoteCommandPolicy(),
)

@Serializable
data class RemoteCommandPolicy(
    val viewerAllowed: Boolean = false,
    val requiresApproval: Boolean = false,
    val localOnly: Boolean = false,
    val queueable: Boolean = false,
)

@Serializable
data class CommandRouting(
    val mode: String = "allowlisted",
    val supportedActions: List<String> = emptyList(),
    val actions: List<RemoteCommandDescriptor> = emptyList(),
)

@Serializable
data class MobileCompatibility(
    val contractVersion: Int = 0,
    val mode: String = "limited",
    val requiredActions: List<String> = emptyList(),
    val missingActions: List<String> = emptyList(),
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncInvalidationBatchPayload. */
@Serializable
data class InvalidationBatch(
    val fromDbVersion: Long = 0,
    val toDbVersion: Long = 0,
    val tables: List<String> = emptyList(),
    val fullRefresh: Boolean = false,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncEnvelopeChunkPayload. */
@Serializable
data class EnvelopeChunk(val chunkId: String, val index: Int, val total: Int, val part: String)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncAddressCandidate. */
@Serializable
data class AddressCandidate(val host: String, val kind: String = "lan")

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncPairingHostIdentity. */
@Serializable
data class PairingHostIdentity(
    val deviceId: String,
    val siteId: String = "",
    val name: String,
    val platform: String = "unknown",
    val deviceType: String = "unknown",
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncPairingQrPayload. */
@Serializable
data class PairingQrPayload(
    val version: Int,
    val hostIdentity: PairingHostIdentity,
    val port: Int,
    val addressCandidates: List<AddressCandidate> = emptyList(),
    val relayUrl: String? = null,
    val claimToken: String? = null,
    val runtimeHostGrant: String? = null,
    val pinConfigured: Boolean? = null,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncPairingRequestPayload. */
@Serializable
data class PairingRequest(
    val code: String,
    val peer: SyncPeerMetadata,
    val pairingCommitVersion: Int = 1,
    val relayAccountToken: String? = null,
    val dpopPublicKey: String? = null,
)

@Serializable
data class PairingError(val code: String, val message: String)

@Serializable
data class PairingRotation(val pendingCommit: Boolean, val expiresInMs: Long)

@Serializable
data class PairingResult(
    val ok: Boolean,
    val deviceId: String? = null,
    val secret: String? = null,
    val rotation: PairingRotation? = null,
    val error: PairingError? = null,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncMobileProjectSummary. */
@Serializable
data class MobileProject(
    val id: String,
    val displayName: String,
    val rootPath: String? = null,
    val repoOwner: String? = null,
    val repoName: String? = null,
    val defaultBaseRef: String? = null,
    val lastOpenedAt: String? = null,
    val iconDataUrl: String? = null,
    val laneCount: Int = 0,
    val isAvailable: Boolean = true,
    val isCached: Boolean = false,
    val isOpen: Boolean = false,
)

@Serializable
data class ProjectCatalog(val projects: List<MobileProject> = emptyList())

/** Wire source: apps/desktop/src/shared/types/sync.ts SyncRosterProject. */
@Serializable
data class RosterProject(
    val projectId: String,
    val rootPath: String? = null,
    val displayName: String,
    val iconDataUrl: String? = null,
    val lastOpenedAt: String? = null,
    val booted: Boolean = false,
    val runningCount: Int = 0,
    val attentionCount: Int = 0,
    val lanes: List<RosterLane> = emptyList(),
    val chats: List<RosterChat> = emptyList(),
)

@Serializable
data class RosterLane(
    val id: String,
    val name: String,
    val color: String? = null,
    val icon: String? = null,
    val laneType: String? = null,
    val branchRef: String? = null,
)

@Serializable
data class RosterChat(
    val id: String,
    val laneId: String,
    val chatSessionId: String? = null,
    val title: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val toolType: String? = null,
    val status: String,
    val awaitingInput: Boolean = false,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val lastActivityAt: String? = null,
    val preview: String? = null,
    val settledAt: String? = null,
    val statusNote: String? = null,
    val attentionRequestedAt: String? = null,
    val attentionMessage: String? = null,
    val lastTurnFailedAt: String? = null,
    val exitCode: Int? = null,
)

@Serializable
data class RosterSnapshot(val seq: Long, val projects: List<RosterProject> = emptyList())

@Serializable
data class RosterDelta(
    val seq: Long,
    val changed: List<RosterProject> = emptyList(),
    val removed: List<String> = emptyList(),
)

/** Wire source: apps/desktop/src/shared/types/sync.ts remote command envelopes. */
@Serializable
data class CommandRequest(val action: String, val args: JsonElement? = null)

@Serializable
data class CommandResult(
    val ok: Boolean = false,
    val result: JsonElement? = null,
    val error: String? = null,
    val code: String? = null,
)

/** Wire source: apps/desktop/src/shared/types/sync.ts chat and terminal sub-protocols. */
@Serializable
data class ChatSubscribe(
    val sessionId: String,
    val sinceSeq: Long? = null,
    val chatScope: String? = null,
)

@Serializable
data class ChatEvent(val sessionId: String, val seq: Long? = null, val event: JsonElement)

@Serializable
data class TerminalSubscribe(val sessionId: String, val sinceOffset: Long? = null, val maxBytes: Int? = null)

@Serializable
data class TerminalInput(val sessionId: String, val data: String, val encoding: String = "base64")

@Serializable
data class TerminalResize(val sessionId: String, val cols: Int, val rows: Int)

/** Account directory response; source: apps/account-directory/src/index.ts. */
@Serializable
data class DirectoryMachine(
    val machineKey: String,
    val deviceId: String? = null,
    val name: String? = null,
    val customName: String? = null,
    val online: Boolean = false,
    val pubkey: String? = null,
    val platform: String? = null,
    val deviceType: String? = null,
    val reachableEndpoints: List<ReachableEndpoint> = emptyList(),
)

@Serializable
data class ReachableEndpoint(
    val kind: String,
    val url: String? = null,
    val host: String? = null,
    val port: Int? = null,
)

@Serializable
data class DirectoryMachineList(val machines: List<DirectoryMachine> = emptyList())

@Serializable
data class AttentionSnapshot(
    val cursor: String? = null,
    val items: List<JsonObject> = emptyList(),
    val preferences: JsonObject? = null,
)
