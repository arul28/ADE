package com.ade.sync.client

import com.ade.sync.auth.Dpop
import com.ade.sync.auth.DpopKey
import com.ade.sync.auth.AccountChallengeOk
import com.ade.sync.auth.SealedAdoption
import com.ade.sync.auth.SealedHelloOk
import com.ade.sync.model.AccountPairing
import com.ade.sync.model.ChatEvent
import com.ade.sync.model.ChatSubscribe
import com.ade.sync.model.CommandResult
import com.ade.sync.model.ConnectionAttempt
import com.ade.sync.model.EnvelopeChunk
import com.ade.sync.model.HelloOkPayload
import com.ade.sync.model.HelloPayload
import com.ade.sync.model.ProjectCatalog
import com.ade.sync.model.RosterDelta
import com.ade.sync.model.RosterSnapshot
import com.ade.sync.model.SyncEnvelope
import com.ade.sync.model.SyncPeerMetadata
import com.ade.sync.model.TerminalResize
import com.ade.sync.model.TerminalSubscribe
import com.ade.sync.protocol.EnvelopeChunkAssembler
import com.ade.sync.protocol.EnvelopeCodec
import com.ade.sync.protocol.InvalidationDomain
import com.ade.sync.protocol.InvalidationScheduler
import com.ade.sync.protocol.validatedInvalidationBatch
import com.ade.sync.transport.ConnectedRoute
import com.ade.sync.transport.ConnectionRace
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.RouteKind
import com.ade.sync.transport.RouteSecurity
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class PairedCredentials(
    val deviceId: String,
    val secret: String,
    val dpopKey: DpopKey,
    /** Must mint/fetch a fresh short-lived Clerk token at invocation time. */
    val freshRelayAccountToken: (suspend () -> String?)? = null,
)

data class AccountAdoptionCredentials(
    val deviceId: String,
    val dpopKey: DpopKey,
    val freshAccountToken: suspend () -> String?,
)

data class AccountAdoptionResult(
    val hello: HelloOkPayload,
    val pairing: AccountPairing,
    val candidate: RouteCandidate,
)

data class SyncConnectionStatus(
    val state: String = "disconnected",
    val endpoint: String? = null,
    val route: RouteKind? = null,
    val hostName: String? = null,
    val error: String? = null,
)

internal data class CommandProjectContext(val projectId: String?, val projectRootPath: String?)

internal fun resolveCommandProjectContext(
    scope: String,
    explicitProjectId: String?,
    explicitProjectRootPath: String?,
    defaultProject: com.ade.sync.model.MobileProject?,
): CommandProjectContext {
    if (scope != "project" || explicitProjectId != null) {
        return CommandProjectContext(explicitProjectId, explicitProjectRootPath)
    }
    return CommandProjectContext(defaultProject?.id, explicitProjectRootPath ?: defaultProject?.rootPath)
}

internal fun requireExpectedHostIdentity(hello: HelloOkPayload, expectedHostDeviceId: String) {
    val actual = hello.brain?.deviceId?.trim()
    require(actual == expectedHostDeviceId.trim()) {
        "Connected machine identity did not match the stored pairing"
    }
}

class RemoteCommandException(val code: String, message: String) : IllegalStateException(message)

class AdeSyncClient(
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build(),
    private val race: ConnectionRace = ConnectionRace(),
    private val codec: EnvelopeCodec = EnvelopeCodec(),
    private val externalScope: CoroutineScope? = null,
) : AutoCloseable {
    private val scope = externalScope ?: CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val chunkAssembler = EnvelopeChunkAssembler()
    private val sockets = ConcurrentHashMap.newKeySet<WebSocket>()
    private val pendingCommands = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    private val _status = MutableStateFlow(SyncConnectionStatus())
    private val _hello = MutableStateFlow<HelloOkPayload?>(null)
    private val _roster = MutableStateFlow<RosterSnapshot?>(null)
    private val _catalog = MutableStateFlow(ProjectCatalog())
    private val _chatEvents = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 128)
    private val _terminalEnvelopes = MutableSharedFlow<SyncEnvelope>(extraBufferCapacity = 256)
    private val _rawEnvelopes = MutableSharedFlow<SyncEnvelope>(extraBufferCapacity = 256)
    private data class QueuedEnvelope(val connectionGeneration: Long, val envelope: SyncEnvelope)

    private val rawEnvelopeQueue = Channel<QueuedEnvelope>(capacity = 4_096)
    private val connectionGeneration = AtomicLong(0)
    private val invalidations = InvalidationScheduler(scope) { _invalidated.emit(it) }
    private val _invalidated = MutableSharedFlow<Set<InvalidationDomain>>(extraBufferCapacity = 8)
    private var activeSocket: WebSocket? = null
    private var relayCredentials: PairedCredentials? = null
    private var relayReauthorizationJob: Job? = null
    private var activeCompression = "none"
    private var activeCompressionThresholdBytes = 512
    private var maximumFrameBytes: Int? = null
    private var defaultProject: com.ade.sync.model.MobileProject? = null

    init {
        scope.launch {
            for ((generation, envelope) in rawEnvelopeQueue) {
                if (generation == connectionGeneration.get()) _rawEnvelopes.emit(envelope)
            }
        }
    }

    val status: StateFlow<SyncConnectionStatus> = _status.asStateFlow()
    val hello: StateFlow<HelloOkPayload?> = _hello.asStateFlow()
    val roster: StateFlow<RosterSnapshot?> = _roster.asStateFlow()
    val catalog: StateFlow<ProjectCatalog> = _catalog.asStateFlow()
    val chatEvents: SharedFlow<ChatEvent> = _chatEvents.asSharedFlow()
    val terminalEnvelopes: SharedFlow<SyncEnvelope> = _terminalEnvelopes.asSharedFlow()
    val rawEnvelopes: SharedFlow<SyncEnvelope> = _rawEnvelopes.asSharedFlow()
    val invalidated: SharedFlow<Set<InvalidationDomain>> = _invalidated.asSharedFlow()

    suspend fun connectPaired(
        candidates: List<RouteCandidate>,
        peer: SyncPeerMetadata,
        credentials: PairedCredentials,
        expectedHostDeviceId: String?,
    ): HelloOkPayload {
        val safeCandidates = candidates.map(RouteSecurity::requireSafe)
        disconnect()
        _status.value = SyncConnectionStatus(state = "connecting")
        val attempt = ConnectionAttempt(UUID.randomUUID().toString(), System.currentTimeMillis())
        val attemptPeer = peer.copy(
            deviceId = credentials.deviceId,
            connectionAttempt = attempt,
        )
        return try {
            val winner: ConnectedRoute<AuthenticatedSocket> = race.connect(safeCandidates) { candidate ->
                val relayToken = if (candidate.kind == RouteKind.RELAY) {
                    credentials.freshRelayAccountToken?.invoke()
                } else null
                val proof = Dpop.proof(
                    credentials.dpopKey,
                    credentials.deviceId,
                    credentials.secret,
                )
                val auth = buildJsonObject {
                    put("kind", "paired")
                    put("deviceId", credentials.deviceId)
                    put("secret", credentials.secret)
                    put("dpop", codec.json.encodeToJsonElement(com.ade.sync.model.DpopProof.serializer(), proof))
                    if (relayToken != null) put("relayAccountToken", relayToken)
                }
                openAndAuthenticate(candidate, HelloPayload(attemptPeer, auth = auth), expectedHostDeviceId)
            }
            relayCredentials = credentials
            activate(winner.candidate, winner.connection)
            winner.connection.hello
        } catch (error: Throwable) {
            disconnect()
            _status.value = SyncConnectionStatus(state = "error", error = error.message)
            throw error
        }
    }

    suspend fun connectBootstrap(
        candidates: List<RouteCandidate>,
        peer: SyncPeerMetadata,
        token: String,
        expectedHostDeviceId: String,
    ): HelloOkPayload {
        require(token.isNotBlank()) { "The project connection omitted its bootstrap token" }
        val safeCandidates = candidates.map(RouteSecurity::requireSafe)
        disconnect()
        _status.value = SyncConnectionStatus(state = "connecting")
        val attemptPeer = peer.copy(
            connectionAttempt = ConnectionAttempt(UUID.randomUUID().toString(), System.currentTimeMillis()),
        )
        return try {
            val winner = race.connect(safeCandidates) { candidate ->
                openAndAuthenticate(
                    candidate,
                    HelloPayload(
                        attemptPeer,
                        auth = buildJsonObject {
                            put("kind", "bootstrap")
                            put("token", token)
                        },
                    ),
                    expectedHostDeviceId,
                )
            }
            relayCredentials = null
            activate(winner.candidate, winner.connection)
            winner.connection.hello
        } catch (error: Throwable) {
            disconnect()
            _status.value = SyncConnectionStatus(state = "error", error = error.message)
            throw error
        }
    }

    /**
     * Adopts a same-account machine and keeps the winning authenticated socket.
     * Direct routes are eligible only when the directory supplies an Ed25519
     * identity key; unsigned legacy machines are relay-only so the Clerk bearer
     * is never disclosed to an unverified LAN endpoint.
     */
    suspend fun connectAccount(
        candidates: List<RouteCandidate>,
        peer: SyncPeerMetadata,
        credentials: AccountAdoptionCredentials,
        expectedHostDeviceId: String,
        directorySigningPublicKey: String?,
    ): AccountAdoptionResult {
        disconnect()
        _status.value = SyncConnectionStatus(state = "connecting")
        val attemptPeer = peer.copy(
            deviceId = credentials.deviceId,
            connectionAttempt = ConnectionAttempt(UUID.randomUUID().toString(), System.currentTimeMillis()),
        )
        val signingKey = directorySigningPublicKey
            ?.removePrefix("ed25519:")
            ?.takeIf(String::isNotBlank)
        val safeCandidates = candidates.map(RouteSecurity::requireSafe)
        val eligible = if (signingKey == null) safeCandidates.filter { it.kind == RouteKind.RELAY } else safeCandidates
        return try {
            val winner = race.connect(eligible) { candidate ->
                openAndAdopt(
                    candidate = candidate,
                    peer = attemptPeer,
                    credentials = credentials,
                    expectedHostDeviceId = expectedHostDeviceId,
                    directorySigningPublicKey = signingKey,
                )
            }
            val pairing = winner.connection.hello.accountPairing
                ?: throw IllegalStateException("The machine did not return paired credentials")
            relayCredentials = PairedCredentials(
                deviceId = pairing.deviceId,
                secret = pairing.secret,
                dpopKey = credentials.dpopKey,
                freshRelayAccountToken = credentials.freshAccountToken,
            )
            activate(winner.candidate, winner.connection)
            AccountAdoptionResult(winner.connection.hello, pairing, winner.candidate)
        } catch (error: Throwable) {
            disconnect()
            _status.value = SyncConnectionStatus(state = "error", error = error.message)
            throw error
        }
    }

    fun supportsRemoteAction(action: String): Boolean = action in
        (_hello.value?.features?.commandRouting?.supportedActions ?: emptyList())

    fun canInvokeRemoteAction(action: String): Boolean {
        if (_status.value.state != "connected") return false
        val descriptor = _hello.value?.features?.commandRouting?.actions?.firstOrNull { it.action == action }
            ?: return false
        return descriptor.policy.viewerAllowed && !descriptor.policy.localOnly
    }

    fun hasSelectedProject(): Boolean = !defaultProject?.id.isNullOrBlank()

    /** Seeds instant-paint JSON snapshots before the transport reconnects. */
    fun seedCached(roster: RosterSnapshot?, catalog: ProjectCatalog?) {
        // Null is meaningful when changing machines: never show the previous
        // host's roster or catalog while the new host has no local cache yet.
        _roster.value = roster
        _catalog.value = catalog ?: ProjectCatalog()
    }

    suspend fun sendCommand(
        action: String,
        args: JsonElement = JsonObject(emptyMap()),
        projectId: String? = null,
        projectRootPath: String? = null,
        timeoutMillis: Long = 30_000,
    ): JsonElement {
        require(canInvokeRemoteAction(action)) { "The connected machine does not allow $action from Android" }
        val descriptor = _hello.value?.features?.commandRouting?.actions?.firstOrNull { it.action == action }
            ?: error("The connected machine did not describe $action")
        val project = resolveCommandProjectContext(
            descriptor.scope,
            projectId,
            projectRootPath,
            defaultProject,
        )
        if (descriptor.scope == "project") {
            require(!project.projectId.isNullOrBlank()) {
                "Select a project before running $action"
            }
        }
        val commandId = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        pendingCommands[commandId] = result
        val payload = buildJsonObject {
            put("commandId", commandId)
            if (project.projectId != null) put("projectId", project.projectId)
            if (project.projectRootPath != null) put("projectRootPath", project.projectRootPath)
            put("action", action)
            put("args", args)
        }
        send("command", payload, commandId, project.projectId)
        return try {
            withTimeout(timeoutMillis) { result.await() }
        } finally {
            pendingCommands.remove(commandId)
        }
    }

    suspend fun request(
        type: String,
        payload: JsonElement = JsonObject(emptyMap()),
        projectId: String? = null,
        timeoutMillis: Long = 30_000,
    ): JsonElement {
        val requestId = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        pendingRequests[requestId] = result
        send(type, payload, requestId, projectId)
        return try {
            withTimeout(timeoutMillis) { result.await() }
        } finally {
            pendingRequests.remove(requestId)
        }
    }

    fun requestProjectCatalog() = send("project_catalog_request", JsonObject(emptyMap()), UUID.randomUUID().toString())

    fun requestRosterSnapshot(sinceSeq: Long? = _roster.value?.seq) {
        send("roster_subscribe", buildJsonObject { if (sinceSeq != null) put("sinceSeq", sinceSeq) })
    }

    fun subscribeChat(
        sessionId: String,
        sinceSeq: Long? = null,
        projectId: String? = null,
        chatScope: String? = null,
    ) {
        val payload = codec.json.encodeToJsonElement(
            ChatSubscribe.serializer(),
            ChatSubscribe(sessionId, sinceSeq, chatScope),
        )
        send("chat_subscribe", payload, projectId = projectId)
    }

    fun unsubscribeChat(sessionId: String, projectId: String? = null, chatScope: String? = null) =
        send("chat_unsubscribe", buildJsonObject {
            put("sessionId", sessionId)
            if (chatScope != null) put("chatScope", chatScope)
        }, projectId = projectId)

    fun subscribeTerminal(sessionId: String, sinceOffset: Long? = null, projectId: String? = null) {
        val payload = codec.json.encodeToJsonElement(
            TerminalSubscribe.serializer(),
            TerminalSubscribe(sessionId, sinceOffset, maxBytes = 2 * 1024 * 1024),
        )
        send("terminal_subscribe", payload, projectId = projectId)
    }

    fun unsubscribeTerminal(sessionId: String, projectId: String? = null) =
        send("terminal_unsubscribe", buildJsonObject { put("sessionId", sessionId) }, projectId = projectId)

    fun sendTerminalInput(sessionId: String, text: String, projectId: String? = null) =
        send("terminal_input", buildJsonObject { put("sessionId", sessionId); put("data", text) }, projectId = projectId)

    fun resizeTerminal(sessionId: String, columns: Int, rows: Int, projectId: String? = null) {
        val payload = codec.json.encodeToJsonElement(
            TerminalResize.serializer(),
            TerminalResize(sessionId, columns.coerceAtLeast(1), rows.coerceAtLeast(1)),
        )
        send("terminal_resize", payload, projectId = projectId)
    }

    fun send(
        type: String,
        payload: JsonElement = JsonNull,
        requestId: String? = null,
        projectId: String? = null,
    ) {
        val socket = activeSocket ?: throw IllegalStateException("ADE is not connected")
        codec.encodeFrames(
            type = type,
            payload = payload,
            requestId = requestId,
            projectId = projectId,
            compression = activeCompression,
            maximumFrameBytes = maximumFrameBytes,
            compressionThresholdBytes = activeCompressionThresholdBytes,
        ).forEach { frame -> check(socket.send(frame)) { "The ADE socket rejected an outgoing frame" } }
    }

    fun disconnect() {
        connectionGeneration.incrementAndGet()
        val active = activeSocket
        activeSocket = null
        defaultProject = null
        relayReauthorizationJob?.cancel()
        relayReauthorizationJob = null
        relayCredentials = null
        sockets.forEach { it.close(1000, "Disconnected") }
        sockets.clear()
        pendingCommands.values.forEach { it.completeExceptionally(IllegalStateException("ADE disconnected")) }
        pendingCommands.clear()
        pendingRequests.values.forEach { it.completeExceptionally(IllegalStateException("ADE disconnected")) }
        pendingRequests.clear()
        chunkAssembler.clear()
        if (active != null || _status.value.state != "error") _status.value = SyncConnectionStatus()
    }

    override fun close() {
        disconnect()
        rawEnvelopeQueue.close()
        invalidations.cancel()
        if (externalScope == null) scope.cancel()
    }

    private data class AuthenticatedSocket(val socket: WebSocket, val hello: HelloOkPayload)

    private fun activate(candidate: RouteCandidate, connection: AuthenticatedSocket) {
        activeSocket = connection.socket
        sockets.filter { it !== activeSocket }.forEach { it.close(1000, "Connection race lost") }
        activeCompression = connection.hello.compression?.codec ?: "none"
        activeCompressionThresholdBytes = connection.hello.compression?.thresholdBytes?.coerceAtLeast(0) ?: 512
        maximumFrameBytes = connection.hello.features.chunkedEnvelopes?.maxFrameBytes
        _hello.value = connection.hello
        _catalog.value = ProjectCatalog(connection.hello.projects)
        defaultProject = connection.hello.projects.firstOrNull { it.isOpen }
        _status.value = SyncConnectionStatus(
            state = "connected",
            endpoint = candidate.url,
            route = candidate.kind,
            hostName = connection.hello.brain?.deviceName,
        )
        invalidations.fullRefresh()
        requestProjectCatalog()
        requestRosterSnapshot()
        scheduleRelayReauthorization(connection.hello.relayAuthorization)
    }

    fun selectProject(projectId: String, rootPath: String?) {
        require(projectId.isNotBlank()) { "Project ID cannot be blank" }
        defaultProject = com.ade.sync.model.MobileProject(
            id = projectId,
            displayName = defaultProject?.displayName.orEmpty(),
            rootPath = rootPath,
            isOpen = true,
        )
    }

    private fun scheduleRelayReauthorization(initial: com.ade.sync.model.RelayAuthorizationLease?) {
        relayReauthorizationJob?.cancel()
        val initialLease = initial ?: return
        if (relayCredentials?.freshRelayAccountToken == null) return
        relayReauthorizationJob = scope.launch {
            var lease = initialLease
            while (activeSocket != null) {
                delay((lease.refreshAfter - System.currentTimeMillis()).coerceAtLeast(0))
                val credentials = relayCredentials ?: return@launch
                val tokenProvider = credentials.freshRelayAccountToken ?: return@launch
                val token = tokenProvider() ?: error("Sign in again to keep the ADE Relay connected")
                val proof = Dpop.relayReauthorizationProof(
                    credentials.dpopKey,
                    credentials.deviceId,
                    token,
                    lease.challenge,
                )
                val result = try {
                    request(
                        "relay_reauthorize",
                        buildJsonObject {
                            put("deviceId", credentials.deviceId)
                            put("relayAccountToken", token)
                            put("proof", codec.json.encodeToJsonElement(
                                com.ade.sync.model.DpopProof.serializer(),
                                proof,
                            ))
                        },
                        timeoutMillis = 6_000,
                    ).jsonObject
                } catch (error: Throwable) {
                    if (System.currentTimeMillis() >= lease.expiresAt + lease.graceMs) {
                        handleDisconnect(error.message ?: "ADE Relay authorization expired")
                        return@launch
                    }
                    delay(1_000)
                    continue
                }
                if (result["ok"]?.jsonPrimitive?.content != "true") {
                    val retryable = (result["error"] as? JsonObject)
                        ?.get("retryable")?.jsonPrimitive?.content == "true"
                    if (!retryable) {
                        handleDisconnect("ADE Relay authorization changed. Direct routes remain available.")
                        return@launch
                    }
                    delay(1_000)
                    continue
                }
                lease = codec.json.decodeFromJsonElement(
                    com.ade.sync.model.RelayAuthorizationLease.serializer(),
                    result["relayAuthorization"] ?: error("Relay refresh omitted its lease"),
                )
            }
        }
    }

    private suspend fun openAndAuthenticate(
        candidate: RouteCandidate,
        hello: HelloPayload,
        expectedHostDeviceId: String?,
    ): AuthenticatedSocket =
        suspendCancellableCoroutine { continuation ->
            val helloJson = codec.json.encodeToJsonElement(HelloPayload.serializer(), hello)
            val relay = candidate.kind == RouteKind.RELAY
            val url = if (relay) candidate.url.toHttpUrl().newBuilder()
                .setQueryParameter("ready", "2")
                .build().toString() else candidate.url
            var helloSent = false
            var accepted = false
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    sockets += webSocket
                    if (!relay) sendHello(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (webSocket === activeSocket) {
                        handleEnvelope(webSocket, text)
                        return
                    }
                    if (relay && !helloSent) {
                        val control = runCatching { codec.json.parseToJsonElement(text).jsonObject }.getOrNull()
                        val kind = control?.get("t")?.jsonPrimitive?.content
                        val version = control?.get("v")?.jsonPrimitive?.content
                        if (kind == "accepted" && version == "2") accepted = true
                        if (kind == "ready" && version == "2" && accepted) sendHello(webSocket)
                        return
                    }
                    val envelope = runCatching { decodeMaybeChunk(text) }.getOrElse {
                        if (continuation.isActive) continuation.resumeWithException(it)
                        return
                    } ?: return
                    when (envelope.type) {
                        "hello_ok" -> {
                            val result = runCatching {
                                codec.json.decodeFromJsonElement(HelloOkPayload.serializer(), envelope.payload)
                            }.getOrElse {
                                if (continuation.isActive) continuation.resumeWithException(it)
                                return
                            }
                            if (
                                result.features.invalidationOnlyV1?.enabled != true ||
                                result.features.compactInvalidationV1?.enabled != true
                            ) {
                                if (continuation.isActive) continuation.resumeWithException(
                                    IllegalStateException("This ADE host does not support Android thin sync. Update ADE on the machine."),
                                )
                                return
                            }
                            if (expectedHostDeviceId != null) {
                                runCatching { requireExpectedHostIdentity(result, expectedHostDeviceId) }.onFailure {
                                    webSocket.close(4003, "Machine identity mismatch")
                                    if (continuation.isActive) continuation.resumeWithException(it)
                                    return
                                }
                            }
                            if (continuation.isActive) continuation.resume(AuthenticatedSocket(webSocket, result))
                        }
                        "hello_error", "account_challenge_error" -> if (continuation.isActive) {
                            val message = (envelope.payload as? JsonObject)?.get("message")?.jsonPrimitive?.content
                                ?: "The ADE machine rejected this connection"
                            continuation.resumeWithException(RemoteCommandException("hello_rejected", message))
                        }
                        else -> Unit // Unknown pre-auth extensions are additive and ignored.
                    }
                }

                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = onMessage(webSocket, bytes.utf8())

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    sockets -= webSocket
                    if (continuation.isActive) continuation.resumeWithException(t)
                    if (webSocket === activeSocket) handleDisconnect(t.message)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    sockets -= webSocket
                    if (continuation.isActive) continuation.resumeWithException(IllegalStateException(reason.ifBlank { "ADE disconnected" }))
                    if (webSocket === activeSocket) handleDisconnect(reason)
                }

                private fun sendHello(webSocket: WebSocket) {
                    if (helloSent) return
                    helloSent = true
                    webSocket.send(codec.encode("hello", helloJson, "hello"))
                }
            }
            val socket = httpClient.newWebSocket(Request.Builder().url(url).build(), listener)
            continuation.invokeOnCancellation { socket.close(1000, "Connection attempt cancelled") }
        }

    private suspend fun openAndAdopt(
        candidate: RouteCandidate,
        peer: SyncPeerMetadata,
        credentials: AccountAdoptionCredentials,
        expectedHostDeviceId: String,
        directorySigningPublicKey: String?,
    ): AuthenticatedSocket = suspendCancellableCoroutine { continuation ->
        val relay = candidate.kind == RouteKind.RELAY
        check(directorySigningPublicKey != null || relay) {
            "Refusing to send account credentials over an unsealed direct route"
        }
        val url = if (relay) candidate.url.toHttpUrl().newBuilder()
            .setQueryParameter("ready", "2")
            .build().toString() else candidate.url
        val adoption = directorySigningPublicKey?.let { SealedAdoption.create() }
        var session: SealedAdoption.Session? = null
        var accepted = false
        var started = false
        var helloSent = false

        fun fail(webSocket: WebSocket, error: Throwable) {
            webSocket.close(4003, "Account adoption failed")
            if (continuation.isActive) continuation.resumeWithException(error)
        }

        fun sendAccountHello(webSocket: WebSocket) {
            if (helloSent) return
            helloSent = true
            scope.launch {
                runCatching {
                    val accountToken = credentials.freshAccountToken()
                        ?: error("Sign in again to connect this machine")
                    val proof = Dpop.proof(
                        credentials.dpopKey,
                        credentials.deviceId,
                        accountToken,
                    )
                    val accountAuth = buildJsonObject {
                        put("deviceId", credentials.deviceId)
                        put("accountToken", accountToken)
                        put("dpop", codec.json.encodeToJsonElement(com.ade.sync.model.DpopProof.serializer(), proof))
                    }
                    val auth = session?.let { secureSession ->
                        buildJsonObject {
                            put("kind", "account_sealed")
                            put("v", 1)
                            put("deviceId", credentials.deviceId)
                            put("sealed", secureSession.sealHello(accountAuth.toString().toByteArray()))
                        }
                    } ?: buildJsonObject {
                        put("kind", "account")
                        accountAuth.forEach { (key, value) -> put(key, value) }
                    }
                    val payload = codec.json.encodeToJsonElement(
                        HelloPayload.serializer(),
                        HelloPayload(peer, auth = auth),
                    )
                    check(webSocket.send(codec.encode("hello", payload, "account-hello"))) {
                        "The account hello could not be sent"
                    }
                }.onFailure { fail(webSocket, it) }
            }
        }

        fun begin(webSocket: WebSocket) {
            if (started) return
            started = true
            if (adoption == null) {
                sendAccountHello(webSocket)
            } else {
                val payload = codec.json.encodeToJsonElement(
                    com.ade.sync.auth.AccountChallenge.serializer(),
                    adoption.challenge,
                )
                if (!webSocket.send(codec.encode("account_challenge", payload, "account-challenge"))) {
                    fail(webSocket, IllegalStateException("The identity challenge could not be sent"))
                }
            }
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                sockets += webSocket
                if (!relay) begin(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket === activeSocket) {
                    handleEnvelope(webSocket, text)
                    return
                }
                if (relay && !started) {
                    val control = runCatching { codec.json.parseToJsonElement(text).jsonObject }.getOrNull()
                    val kind = control?.get("t")?.jsonPrimitive?.content
                    val version = control?.get("v")?.jsonPrimitive?.content
                    if (kind == "accepted" && version == "2") accepted = true
                    if (kind == "ready" && version == "2" && accepted) begin(webSocket)
                    return
                }
                val envelope = runCatching { decodeMaybeChunk(text) }.getOrElse {
                    fail(webSocket, it)
                    return
                } ?: return
                when (envelope.type) {
                    "account_challenge_ok" -> {
                        val activeAdoption = adoption ?: return
                        val response = runCatching {
                            codec.json.decodeFromJsonElement(AccountChallengeOk.serializer(), envelope.payload)
                        }.getOrElse {
                            fail(webSocket, it)
                            return
                        }
                        session = runCatching {
                            activeAdoption.verifyAndDerive(
                                response = response,
                                expectedHostDeviceId = expectedHostDeviceId,
                                directorySigningPublicKeyBase64 = directorySigningPublicKey,
                                clientDeviceId = credentials.deviceId,
                            )
                        }.getOrElse {
                            fail(webSocket, it)
                            return
                        }
                        sendAccountHello(webSocket)
                    }
                    "hello_ok" -> {
                        val result = runCatching {
                            val payload = session?.let { secureSession ->
                                val sealed = codec.json.decodeFromJsonElement(SealedHelloOk.serializer(), envelope.payload)
                                codec.json.parseToJsonElement(
                                    secureSession.openHelloOk(sealed.sealed).toString(Charsets.UTF_8),
                                )
                            } ?: envelope.payload
                            codec.json.decodeFromJsonElement(HelloOkPayload.serializer(), payload)
                        }.getOrElse {
                            fail(webSocket, it)
                            return
                        }
                        if (
                            result.features.invalidationOnlyV1?.enabled != true ||
                            result.features.compactInvalidationV1?.enabled != true
                        ) {
                            fail(webSocket, IllegalStateException(
                                "This ADE host does not support Android thin sync. Update ADE on the machine.",
                            ))
                            return
                        }
                        if (continuation.isActive) continuation.resume(AuthenticatedSocket(webSocket, result))
                    }
                    "hello_error", "account_challenge_error" -> {
                        val message = (envelope.payload as? JsonObject)?.get("message")?.jsonPrimitive?.content
                            ?: "The ADE machine rejected account adoption"
                        fail(webSocket, RemoteCommandException("account_adoption_rejected", message))
                    }
                    else -> Unit
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = onMessage(webSocket, bytes.utf8())

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets -= webSocket
                if (continuation.isActive) continuation.resumeWithException(t)
                if (webSocket === activeSocket) handleDisconnect(t.message)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sockets -= webSocket
                if (continuation.isActive) continuation.resumeWithException(
                    IllegalStateException(reason.ifBlank { "ADE disconnected" }),
                )
                if (webSocket === activeSocket) handleDisconnect(reason)
            }
        }
        val socket = httpClient.newWebSocket(Request.Builder().url(url).build(), listener)
        continuation.invokeOnCancellation { socket.close(1000, "Connection attempt cancelled") }
    }

    private fun decodeMaybeChunk(text: String): SyncEnvelope? {
        val envelope = codec.decode(text)
        if (envelope.type != "envelope_chunk") return envelope
        val chunk = codec.json.decodeFromJsonElement(EnvelopeChunk.serializer(), envelope.payload)
        val reassembled = chunkAssembler.add(chunk) ?: return null
        return codec.decode(reassembled)
    }

    private fun handleEnvelope(webSocket: WebSocket, text: String) {
        if (webSocket !== activeSocket) return
        val envelope = runCatching { decodeMaybeChunk(text) }.getOrElse {
            handleDisconnect(it.message)
            return
        } ?: return
        val queuedEnvelope = QueuedEnvelope(connectionGeneration.get(), envelope)
        if (rawEnvelopeQueue.trySend(queuedEnvelope).isFailure) {
            webSocket.close(4002, "Inbound stream overflow")
            handleDisconnect("The Android stream fell behind; reconnect to resume safely")
            return
        }
        envelope.requestId?.let { pendingRequests.remove(it)?.complete(envelope.payload) }
        when (envelope.type) {
            "heartbeat" -> send("heartbeat_ack", envelope.payload, envelope.requestId)
            "invalidation_batch" -> invalidations.receive(validatedInvalidationBatch(envelope.payload))
            "roster_snapshot" -> runCatching {
                codec.json.decodeFromJsonElement(RosterSnapshot.serializer(), envelope.payload)
            }.onSuccess { _roster.value = it }
            "roster_delta" -> runCatching {
                codec.json.decodeFromJsonElement(RosterDelta.serializer(), envelope.payload)
            }.onSuccess(::applyRosterDelta)
            "project_catalog" -> runCatching {
                codec.json.decodeFromJsonElement(ProjectCatalog.serializer(), envelope.payload)
            }.onSuccess { catalog ->
                _catalog.value = catalog
                catalog.projects.firstOrNull { it.isOpen }?.let { defaultProject = it }
            }
            "command_result" -> handleCommandResult(envelope.payload)
            "chat_event" -> runCatching {
                codec.json.decodeFromJsonElement(ChatEvent.serializer(), envelope.payload)
            }.onSuccess { _chatEvents.tryEmit(it) }
            "terminal_snapshot", "terminal_data", "terminal_exit", "terminal_history", "terminal_input_ack" ->
                _terminalEnvelopes.tryEmit(envelope)
            "relay_reauthorize" -> Unit // The app layer responds with a freshly fetched token.
            // Unknown rpc/fwd/desktop-only envelopes are additive and ignored.
        }
    }

    private fun handleCommandResult(payload: JsonElement) {
        val source = payload as? JsonObject ?: return
        val commandId = source["commandId"]?.jsonPrimitive?.content ?: return
        val pending = pendingCommands[commandId] ?: return
        val ok = source["ok"]?.jsonPrimitive?.content == "true"
        if (ok) {
            pending.complete(source["result"] ?: JsonNull)
        } else {
            val error = source["error"] as? JsonObject
            pending.completeExceptionally(RemoteCommandException(
                error?.get("code")?.jsonPrimitive?.content ?: "command_failed",
                error?.get("message")?.jsonPrimitive?.content ?: "The remote command failed",
            ))
        }
    }

    private fun applyRosterDelta(delta: RosterDelta) {
        when (val outcome = mergeRosterDelta(_roster.value, delta)) {
            RosterDeltaOutcome.NeedsSnapshot -> requestRosterSnapshot(null)
            RosterDeltaOutcome.Dropped -> Unit
            is RosterDeltaOutcome.Applied -> _roster.value = outcome.snapshot
        }
    }

    private fun handleDisconnect(message: String?) {
        connectionGeneration.incrementAndGet()
        val disconnectedSocket = activeSocket
        activeSocket = null
        disconnectedSocket?.close(4002, "Connection lost")
        if (disconnectedSocket != null) sockets -= disconnectedSocket
        relayReauthorizationJob?.cancel()
        relayReauthorizationJob = null
        _status.value = SyncConnectionStatus(state = "error", error = message ?: "ADE disconnected")
        pendingCommands.values.forEach { it.completeExceptionally(IllegalStateException("ADE disconnected")) }
        pendingCommands.clear()
        pendingRequests.values.forEach { it.completeExceptionally(IllegalStateException("ADE disconnected")) }
        pendingRequests.clear()
    }

}

internal sealed interface RosterDeltaOutcome {
    data object NeedsSnapshot : RosterDeltaOutcome
    data object Dropped : RosterDeltaOutcome
    data class Applied(val snapshot: RosterSnapshot) : RosterDeltaOutcome
}

internal fun mergeRosterDelta(current: RosterSnapshot?, delta: RosterDelta): RosterDeltaOutcome {
    current ?: return RosterDeltaOutcome.NeedsSnapshot
    if (delta.seq <= current.seq) return RosterDeltaOutcome.Dropped
    if (delta.seq != current.seq + 1) return RosterDeltaOutcome.NeedsSnapshot
    val projects = current.projects.associateBy { it.projectId }.toMutableMap()
    delta.removed.forEach(projects::remove)
    delta.changed.forEach { projects[it.projectId] = it }
    return RosterDeltaOutcome.Applied(RosterSnapshot(delta.seq, projects.values.toList()))
}
