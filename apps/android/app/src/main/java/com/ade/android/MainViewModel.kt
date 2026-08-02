package com.ade.android

import android.app.Application
import android.app.NotificationManager
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ade.android.connection.AdeConnectionService
import com.ade.android.connection.ReconnectWorker
import com.ade.android.data.Appearance
import com.ade.android.pairing.NearbyDiscovery
import com.ade.android.security.MachineProfile
import com.ade.sync.model.DirectoryMachine
import com.ade.sync.model.MobileProject
import com.ade.sync.model.PairingQrPayload
import com.ade.sync.model.RosterSnapshot
import com.ade.sync.model.RosterProject
import com.ade.sync.pairing.PairingQr
import com.ade.sync.protocol.InvalidationDomain
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * Wire source: `LaneSummary` + `LaneListSnapshot` in
 * apps/desktop/src/shared/types/lanes.ts:78-106 / 222-230, as returned by
 * `lanes.refreshSnapshots` with `includeStatus: true`.
 */
data class UiLane(
    val id: String,
    val name: String,
    val branch: String? = null,
    val state: String? = null,
    val running: Int = 0,
    val awaiting: Int = 0,
    val archived: Boolean = false,
    val laneType: String? = null,
    val description: String? = null,
    // LaneSummary.color — nullable hex string.
    val color: String? = null,
    // LaneSummary.status (LaneStatus, lanes.ts:20-33). Present only when the
    // request asked for includeStatus.
    val dirty: Boolean = false,
    val ahead: Int = 0,
    val behind: Int = 0,
    val remoteBehind: Int = 0,
    val rebaseInProgress: Boolean = false,
    val hasStatus: Boolean = false,
    val childCount: Int = 0,
    val stackDepth: Int = 0,
    val parentLaneId: String? = null,
    // LaneSummary.linearIssue.identifier.
    val linearIdentifier: String? = null,
    // LaneSummary.devicesOpen (DeviceMarker[]), injected by the host presence
    // decorator with a 60s TTL; we only need the count for the card badge.
    val devicesOpen: Int = 0,
)

enum class SessionKind { CHAT, TERMINAL }

/**
 * Wire source: `TerminalSessionSummary` in
 * apps/desktop/src/shared/types/sessions.ts:160-273, as returned by
 * `work.listSessions` (a bare array).
 */
data class UiSession(
    val id: String,
    val laneId: String?,
    val laneName: String?,
    val title: String,
    val provider: String?,
    val toolType: String?,
    val runtimeState: String?,
    val preview: String?,
    val pendingInputItemId: String? = null,
    val kind: SessionKind,
    val personal: Boolean = false,
    val archived: Boolean = false,
    val model: String? = null,
    /** Host-reported reasoning effort, from `chat.getSummary`. */
    val reasoningEffort: String? = null,
    /** Host-reported fast-mode (service tier) flag, from `chat.getSummary`. */
    val fastMode: Boolean = false,
    // Everything below is present on every `work.listSessions` row (explicit
    // null rather than omitted — sessionService.mapRow spreads the SQL row).
    val status: String? = null,
    val startedAt: String? = null,
    val lastActivityAt: String? = null,
    val settledAt: String? = null,
    val statusNote: String? = null,
    val attentionRequestedAt: String? = null,
    val attentionMessage: String? = null,
    val lastTurnFailedAt: String? = null,
    val exitCode: Int? = null,
    val pinned: Boolean = false,
    val summary: String? = null,
    val goal: String? = null,
    val currentTurnStartedAt: String? = null,
)

data class UiProjectBrowseEntry(val name: String, val fullPath: String, val gitRepository: Boolean)
data class UiGitHubRepo(val fullName: String, val cloneUrl: String, val private: Boolean)
data class UiModel(
    val id: String,
    val runtimeModelId: String,
    val name: String,
    val provider: String,
    val defaultReasoning: String? = null,
    val reasoningEfforts: List<String> = emptyList(),
    /** `chat.modelCatalog` service tiers. Fast mode is supported iff this contains "fast". */
    val serviceTiers: List<String> = emptyList(),
)

/**
 * Persisted Work tab view state. Mirrors the iOS `ade.work.viewStateByScope.v1`
 * store; the host half of the iOS `"<hostIdentity>::<projectId>"` scope is
 * already the per-machine DataStore namespace here, so the scope is the project id.
 */
@Serializable
data class WorkViewState(
    val query: String = "",
    val statusFilter: String = "all",
    val laneFilter: String? = null,
    val organization: String = "BY_LANE",
)

@Serializable
data class HubComposerPreferences(
    val projectId: String? = null,
    val laneId: String? = null,
    val cli: Boolean = false,
    val modelId: String? = null,
    val permissionMode: String = "default",
    val reasoning: String? = null,
)

internal fun normalizeChatEventEnvelope(envelope: JsonObject): JsonObject {
    val event = envelope["event"] as? JsonObject ?: return envelope
    val normalized = event.toMutableMap()
    listOf("sessionId", "timestamp", "sequence", "seq", "provenance").forEach { key ->
        if (key !in normalized) envelope[key]?.let { normalized[key] = it }
    }
    return JsonObject(normalized)
}

data class MainUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val signedIn: Boolean = false,
    val accountName: String? = null,
    val accountEmail: String? = null,
    val machines: List<DirectoryMachine> = emptyList(),
    val savedMachines: List<MachineProfile> = emptyList(),
    val pairingPayload: PairingQrPayload? = null,
    val pairingPin: String = "",
    val lanes: List<UiLane> = emptyList(),
    val laneDetails: Map<String, JsonObject> = emptyMap(),
    val sessions: List<UiSession> = emptyList(),
    val personalChats: List<UiSession> = emptyList(),
    val transcript: List<JsonObject> = emptyList(),
    val historyStartOffset: Long? = null,
    val historyHasMore: Boolean = false,
    val selectedSessionId: String? = null,
    val terminalData: String = "",
    val terminalStartOffset: Long? = null,
    val terminalEndOffset: Long? = null,
    val terminalAtStart: Boolean = false,
    val quota: JsonElement? = null,
    val attentionItems: List<JsonObject> = emptyList(),
    val attentionCursor: String? = null,
    val attentionStreamId: String? = null,
    val attentionPreferences: JsonObject? = null,
    val hubCollapsedProjectIds: Set<String> = emptySet(),
    val hubCollapsedLaneKeys: Set<String> = emptySet(),
    /** `"<scope>:<groupId>"` entries for collapsed Work tab groups. */
    val workCollapsedKeys: Set<String> = emptySet(),
    /** Work tab search/filter/grouping, keyed by scope (the project id). */
    val workViewStates: Map<String, WorkViewState> = emptyMap(),
    val hubProjectOrder: List<String> = emptyList(),
    val hubComposerDraft: String = "",
    val hubComposerPreferences: HubComposerPreferences = HubComposerPreferences(),
    val projectDefaultParent: String = "",
    val projectBrowseEntries: List<UiProjectBrowseEntry> = emptyList(),
    val githubRepos: List<UiGitHubRepo> = emptyList(),
    val models: List<UiModel> = emptyList(),
    /** Model picker favourites — host-owned via `modelPicker.*`, mirrored locally. */
    val modelFavourites: Set<String> = emptySet(),
    /** Model picker recents, most recent first. */
    val modelRecents: List<String> = emptyList(),
    val deepLinkSequence: Long = 0,
    val deepLinkSessionId: String? = null,
    val deepLinkMachineKey: String? = null,
    val openingProjectName: String? = null,
    /** True while the app is retrying a dropped connection on its own. */
    val reconnecting: Boolean = false,
) {
    fun terminalTranscript() =
        TerminalTranscriptState(terminalData, terminalStartOffset, terminalEndOffset, terminalAtStart)
}

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val graph = (application as AdeApplication).graph
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val laneRefreshInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
    private var autoReconnectJob: Job? = null
    private val _ui = MutableStateFlow(MainUiState(
        signedIn = graph.auth.signedIn,
        accountName = graph.auth.displayName,
        accountEmail = graph.auth.emailAddress,
        savedMachines = graph.machineStore.list(),
    ))
    val ui: StateFlow<MainUiState> = _ui.asStateFlow()
    val syncStatus = graph.sync.status
    val roster = graph.sync.roster
    val catalog = graph.sync.catalog
    val hello = graph.sync.hello
    val nearby = NearbyDiscovery(application, viewModelScope)
    val appearance = graph.preferences.appearance
    val analyticsEnabled = graph.preferences.analyticsEnabled
    val pushEnabled = graph.preferences.pushEnabled
    private var attentionDrawerVisible = false
    private var appForeground = true
    private val chatSequenceBySession = mutableMapOf<String, Long>()

    init {
        graph.auth.sessionFlow?.let { sessions ->
            viewModelScope.launch {
                sessions.collectLatest { session ->
                    val signedIn = session != null
                    val changed = _ui.value.signedIn != signedIn
                    _ui.update { it.copy(
                        signedIn = signedIn,
                        accountName = graph.auth.displayName,
                        accountEmail = graph.auth.emailAddress,
                    ) }
                    if (signedIn && changed) {
                        refreshDirectory()
                        refreshAttention()
                    }
                }
            }
        }
        viewModelScope.launch {
            graph.sync.invalidated.collectLatest { domains ->
                // Coalesce invalidation bursts. One user-visible change is
                // routinely several host transactions (creating a lane writes
                // the lane row, its branch profile and its state snapshot
                // separately), so a single action can deliver several batches
                // back to back. `collectLatest` cancels this delay when a newer
                // batch lands, so the burst collapses into one refresh instead
                // of one full lane-status sweep per batch.
                //
                // This is coalescing, not a workaround: the refresh-feedback
                // loop it was originally added to survive is fixed host-side —
                // `upsertBranchProfileForRow` no longer rewrites an unchanged
                // profile, so serving a refresh no longer emits an
                // invalidation. Kept because burst coalescing is worth having
                // on its own.
                delay(INVALIDATION_REFRESH_DEBOUNCE_MS)
                if (InvalidationDomain.LANES in domains) refreshLanes()
                if (InvalidationDomain.SESSIONS in domains || InvalidationDomain.CHATS in domains) {
                    refreshSessions()
                    refreshPersonalChats()
                }
                if (InvalidationDomain.PROJECTS in domains) {
                    graph.sync.requestProjectCatalog()
                    graph.sync.requestRosterSnapshot()
                }
                if (InvalidationDomain.ATTENTION in domains && _ui.value.signedIn) refreshAttention()
                if (InvalidationDomain.USAGE in domains) refreshQuota()
            }
        }
        viewModelScope.launch {
            // Nothing else notices a host that went away: the socket simply
            // closes and the Hub keeps painting its cache. Watch the transport
            // directly so a runtime restart heals without Settings -> Reconnect.
            graph.sync.status.collect { status ->
                when (status.state) {
                    "connected" -> {
                        autoReconnectJob?.cancel()
                        autoReconnectJob = null
                        if (_ui.value.reconnecting) _ui.update { it.copy(reconnecting = false) }
                    }
                    "disconnected", "error" -> startAutoReconnect()
                    else -> Unit
                }
            }
        }
        viewModelScope.launch {
            graph.sync.rawEnvelopes.collect { envelope ->
                when (envelope.type) {
                    "chat_subscribe" -> appendSnapshotEvents(envelope.payload)
                    "chat_event" -> appendChatEvent(envelope.payload)
                    "terminal_snapshot" -> applyTerminal(envelope.payload, replace = true)
                    "terminal_data" -> applyTerminal(envelope.payload, replace = false)
                }
            }
        }
        viewModelScope.launch {
            graph.sync.roster.collect { value ->
                val machineKey = graph.machineStore.current()?.machineKey ?: return@collect
                if (value != null) graph.preferences.cache(
                    machineKey,
                    "roster",
                    json.encodeToString(RosterSnapshot.serializer(), value),
                )
            }
        }
        viewModelScope.launch {
            graph.sync.catalog.collect { value ->
                val machineKey = graph.machineStore.current()?.machineKey ?: return@collect
                if (value.projects.isNotEmpty()) graph.preferences.cache(
                    machineKey,
                    "catalog",
                    json.encodeToString(com.ade.sync.model.ProjectCatalog.serializer(), value),
                )
            }
        }
        graph.machineStore.current()?.let { profile ->
            viewModelScope.launch { connect(profile) }
        }
        if (graph.auth.signedIn) {
            refreshAttention()
            viewModelScope.launch {
                if (BuildConfig.FCM_PROJECT_ID.isNotBlank()) {
                    runCatching { updatePushRegistration(graph.preferences.pushEnabled.first()) }
                }
            }
        }
    }

    fun clearError() = _ui.update { it.copy(error = null) }

    fun sendEmailCode(email: String, onSuccess: () -> Unit) = launchBusy {
        graph.auth.sendEmailCode(email).getOrThrow()
        onSuccess()
    }

    fun verifyEmailCode(code: String, onSuccess: () -> Unit) = launchBusy {
        graph.auth.verifyEmailCode(code).getOrThrow()
        _ui.update { it.copy(
            signedIn = true,
            accountName = graph.auth.displayName,
            accountEmail = graph.auth.emailAddress,
        ) }
        refreshDirectory()
        refreshAttentionNow()
        if (BuildConfig.FCM_PROJECT_ID.isNotBlank()) {
            runCatching { updatePushRegistration(graph.preferences.pushEnabled.first()) }
        }
        onSuccess()
    }

    fun signOut() = launchBusy {
        graph.attentionActionMutex.withLock {
            // Revoke this account's push route while the short-lived Clerk token
            // is still available. Pairing secrets remain intentionally intact.
            runCatching { graph.attention.unregisterForSignOut() }
            graph.auth.signOut().getOrThrow()
            graph.sync.disconnect()
            AdeConnectionService.stop(getApplication())
            getApplication<Application>().getSystemService(NotificationManager::class.java).cancelAll()
        }
        // Machine profiles and DPoP keys intentionally remain for LAN reconnect.
        _ui.update { it.copy(
            signedIn = false,
            accountName = null,
            accountEmail = null,
            machines = emptyList(),
            attentionItems = emptyList(),
            attentionCursor = null,
            attentionStreamId = null,
            attentionPreferences = null,
        ) }
    }

    fun refreshDirectory() = launchBusy {
        val machines = graph.directory.machines()
        reconcileDirectoryMachineMappings(machines)
        _ui.update { it.copy(machines = machines, savedMachines = graph.machineStore.list()) }
    }

    fun renameMachine(machineKey: String, name: String) = launchBusy {
        val normalized = name.trim()
        val saved = graph.machineStore.get(machineKey)
        val directoryKey = _ui.value.machines.firstOrNull { directory -> saved?.matches(directory) == true }?.machineKey
        if (directoryKey != null) graph.directory.rename(directoryKey, normalized)
        saved?.let { graph.machineStore.put(it.copy(name = normalized)) }
        _ui.update { it.copy(
            machines = if (directoryKey != null) graph.directory.machines() else it.machines,
            savedMachines = graph.machineStore.list(),
        ) }
    }

    fun setPairingText(raw: String): Boolean {
        val payload = PairingQr.parse(raw)
        if (payload == null) {
            _ui.update { it.copy(error = "That is not a valid ADE pairing QR code.") }
            return false
        }
        _ui.update { it.copy(pairingPayload = payload, pairingPin = "") }
        return true
    }

    fun setPairingPin(pin: String) = _ui.update { it.copy(pairingPin = pin.filter(Char::isDigit).take(6)) }

    fun pair(onSuccess: () -> Unit) = launchBusy {
        val state = _ui.value
        val payload = state.pairingPayload ?: error("Scan an ADE pairing QR first")
        graph.pairing.pair(payload, state.pairingPin)
        reconcileAnalyticsPreference()
        captureAppOpenedNow()
        _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
        refreshAllNow()
        onSuccess()
    }

    fun connect(profile: MachineProfile, onSuccess: (() -> Unit)? = null) = launchBusy {
        loadCache(profile.machineKey)
        graph.pairing.connect(profile)
        reconcileAnalyticsPreference()
        captureAppOpenedNow()
        refreshAllNow()
        resumeSelectedStream()
        _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
        onSuccess?.invoke()
    }

    fun connectAccount(machine: DirectoryMachine, onSuccess: () -> Unit) = launchBusy {
        val previous = currentMachine()
        try {
            loadCache(machine.machineKey)
            graph.pairing.adopt(machine)
            reconcileAnalyticsPreference()
            captureAppOpenedNow()
            _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
            refreshAllNow()
            resumeSelectedStream()
            onSuccess()
        } catch (error: Throwable) {
            // Account adoption tears down the active transport before racing
            // the remote routes. If every route fails, restore the last saved
            // machine so one bad directory entry does not strand the app in a
            // misleading error state attached to that previous machine.
            if (previous != null) {
                runCatching {
                    loadCache(previous.machineKey)
                    graph.pairing.connect(previous)
                    refreshAllNow()
                    resumeSelectedStream()
                }
            }
            throw error
        }
    }

    fun disconnect() {
        graph.pairing.disconnect()
        AdeConnectionService.stop(getApplication())
    }

    fun forget(machineKey: String) = launchBusy {
        graph.pairing.forget(machineKey)
        graph.preferences.clearMachine(machineKey)
        graph.sync.seedCached(null, null)
        AdeConnectionService.stop(getApplication())
        _ui.update { it.copy(
            savedMachines = graph.machineStore.list(),
            lanes = emptyList(),
            laneDetails = emptyMap(),
            sessions = emptyList(),
            personalChats = emptyList(),
            transcript = emptyList(),
            terminalData = "",
            selectedSessionId = null,
        ) }
    }

    fun currentMachine(): MachineProfile? = graph.machineStore.current()

    fun refreshAll() {
        graph.sync.requestRosterSnapshot()
        graph.sync.requestProjectCatalog()
        refreshLanes()
        refreshSessions()
        refreshModelCatalog()
        refreshPersonalChats()
        refreshQuota()
        if (_ui.value.signedIn) refreshAttention()
    }

    fun openSession(session: UiSession) {
        _ui.update { it.copy(
            selectedSessionId = session.id,
            transcript = emptyList(),
            terminalData = "",
            terminalStartOffset = null,
            terminalEndOffset = null,
            terminalAtStart = false,
            historyStartOffset = null,
            historyHasMore = false,
        ) }
        if (session.kind == SessionKind.CHAT) {
            graph.sync.subscribeChat(
                session.id,
                chatSequenceBySession[session.id],
                chatScope = if (session.personal) "personal" else null,
            )
        } else {
            graph.sync.subscribeTerminal(session.id)
        }
        AdeConnectionService.start(getApplication(), currentMachine()?.name)
    }

    /** Host-reported model settings per session id, from `chat.getSummary`. */
    private data class SessionModelSettings(val modelId: String, val effort: String?, val fastMode: Boolean)

    private val sessionModelSettings = mutableMapOf<String, SessionModelSettings>()

    /**
     * `work.listSessions` does not carry the session's model, so the picker would
     * open blank on a cold start even though the host has one. `chat.getSummary`
     * does (model / modelId / reasoningEffort / fastMode — AgentChatSessionSummary
     * in apps/desktop/src/shared/types/chat.ts).
     *
     * Deliberately lazy — called when the model picker opens, never on session
     * open. Issuing it alongside the transcript subscription put it on the same
     * command channel as the history fetch and pushed that past its 30 s
     * timeout, leaving the transcript empty behind a "Timed out" banner. The
     * result is cached per session and re-applied on every roster refresh.
     */
    fun ensureSessionModelLoaded(sessionId: String) = launchQuiet {
        if (sessionModelSettings.containsKey(sessionId)) return@launchQuiet
        val action = chatAction("getSummary", sessionId)
        if (!graph.sync.canInvokeRemoteAction(action)) return@launchQuiet
        val summary = runCatching {
            graph.sync.sendCommand(action, buildJsonObject { put("sessionId", sessionId) })
        }.getOrNull() as? JsonObject ?: return@launchQuiet
        val modelId = summary.string("modelId") ?: summary.string("model") ?: return@launchQuiet
        sessionModelSettings[sessionId] = SessionModelSettings(
            modelId = modelId,
            effort = summary.string("reasoningEffort"),
            fastMode = summary["fastMode"]?.jsonPrimitive?.content == "true",
        )
        _ui.update { it.copy(
            sessions = applySessionModels(it.sessions),
            personalChats = applySessionModels(it.personalChats),
        ) }
    }

    private fun applySessionModels(list: List<UiSession>): List<UiSession> = list.map { session ->
        val settings = sessionModelSettings[session.id] ?: return@map session
        session.copy(
            model = settings.modelId,
            reasoningEffort = settings.effort,
            fastMode = settings.fastMode,
        )
    }

    fun closeSession() {
        val id = _ui.value.selectedSessionId ?: return
        val session = selectedSession(id)
        if (session?.kind == SessionKind.TERMINAL) {
            graph.sync.unsubscribeTerminal(id)
        } else {
            graph.sync.unsubscribeChat(id, chatScope = if (session?.personal == true) "personal" else null)
            chatSequenceBySession.remove(id)
        }
        _ui.update { it.copy(
            selectedSessionId = null,
            transcript = emptyList(),
            terminalData = "",
            terminalStartOffset = null,
            terminalEndOffset = null,
            terminalAtStart = false,
            historyStartOffset = null,
            historyHasMore = false,
        ) }
        reconcileForegroundService(_ui.value.sessions + _ui.value.personalChats)
    }

    fun loadOlderChat() = launchQuiet {
        val sessionId = _ui.value.selectedSessionId ?: return@launchQuiet
        val before = _ui.value.historyStartOffset ?: return@launchQuiet
        val action = chatAction("getEventHistoryPage", sessionId)
        if (before <= 0 || !graph.sync.canInvokeRemoteAction(action)) return@launchQuiet
        val page = graph.sync.sendCommand(action, buildJsonObject {
            put("sessionId", sessionId)
            put("beforeOffset", before)
            put("maxBytes", 512_000)
        }, timeoutMillis = 8_000).jsonObject
        val events = (page["events"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .map(::normalizeChatEventEnvelope)
        val next = page["startOffset"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0
        val hasMore = page["hasMore"]?.jsonPrimitive?.content == "true" && next > 0
        _ui.update { state -> state.copy(
            transcript = (events + state.transcript).distinctBy { event ->
                event.string("id") ?: event.string("eventId") ?: event.toString()
            },
            historyStartOffset = next,
            historyHasMore = hasMore,
        ) }
    }

    fun loadOlderTerminal() = launchQuiet {
        val sessionId = _ui.value.selectedSessionId ?: return@launchQuiet
        val before = _ui.value.terminalStartOffset ?: return@launchQuiet
        if (before <= 0) return@launchQuiet
        val page = graph.sync.request("terminal_history", buildJsonObject {
            put("sessionId", sessionId)
            put("beforeOffset", before)
            put("maxBytes", 512_000)
        }).jsonObject
        _ui.update {
            val merged = prependTerminalHistory(it.terminalTranscript(), page, before)
            it.copy(
                terminalData = merged.data,
                terminalStartOffset = merged.startOffset,
                terminalAtStart = merged.atStart,
            )
        }
    }

    fun sendChat(text: String, attachmentUri: Uri? = null) = launchBusy {
        val sessionId = _ui.value.selectedSessionId ?: error("Open a chat first")
        val attachmentAction = chatAction("saveTempAttachment", sessionId)
        val attachmentPath = attachmentUri?.let { uri ->
            require(graph.sync.canInvokeRemoteAction(attachmentAction)) {
                "This machine does not support Android chat attachments"
            }
            val (filename, mimeType, bytes) = readAttachment(uri)
            val saved = graph.sync.sendCommand(attachmentAction, buildJsonObject {
                put("filename", filename)
                put("dataUrl", "data:$mimeType;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}")
            }).jsonObject
            saved.string("path") ?: error("The machine did not save the attachment")
        }
        graph.sync.sendCommand(chatAction("send", sessionId), buildJsonObject {
            put("sessionId", sessionId)
            put("text", text.trim().ifBlank { if (attachmentPath != null) "See attached image." else error("Write a message first") })
            if (attachmentPath != null) putJsonArray("attachments") {
                add(buildJsonObject {
                    put("path", attachmentPath)
                    put("type", "image")
                })
            }
        })
        AdeConnectionService.start(getApplication(), currentMachine()?.name)
        graph.sync.requestRosterSnapshot()
    }

    /**
     * `chat.approve` / `personalChats.approve`. [decision] is the wire value of
     * `AgentChatApprovalDecision` — "accept" | "accept_for_session" | "decline"
     * — and [feedback] carries plan-rejection text as `responseText`.
     */
    internal fun approve(
        sessionId: String,
        itemId: String,
        decision: com.ade.android.ui.ApprovalDecision,
        feedback: String? = null,
    ) = launchBusy {
        val action = chatAction("approve", sessionId)
        require(graph.sync.canInvokeRemoteAction(action)) { "This machine does not allow approvals" }
        graph.sync.sendCommand(action, buildJsonObject {
            put("sessionId", sessionId)
            put("itemId", itemId)
            put("decision", decision.wire)
            feedback?.trim()?.takeIf(String::isNotEmpty)?.let { put("responseText", it) }
        })
    }

    /**
     * `chat.interrupt` / `personalChats.interrupt`. "stop_only" leaves any queued
     * follow-up messages intact, matching the iOS stop button.
     */
    fun interruptSession(sessionId: String, clearQueue: Boolean = false) = launchBusy {
        val action = chatAction("interrupt", sessionId)
        require(graph.sync.canInvokeRemoteAction(action)) { "This machine does not allow stopping a turn" }
        graph.sync.sendCommand(action, buildJsonObject {
            put("sessionId", sessionId)
            put("mode", if (clearQueue) "stop_and_clear" else "stop_only")
        })
        graph.sync.requestRosterSnapshot()
    }

    /**
     * `chat.updateSession` / `personalChats.updateSession`. The host takes the
     * catalog model id, an optional reasoning effort, and `fastMode` (aliased as
     * `codexFastMode` host-side) — see `parseAgentChatUpdateSessionArgs`.
     */
    fun setSessionModel(
        sessionId: String,
        modelId: String,
        effort: String?,
        fastMode: Boolean,
    ) = launchBusy {
        val action = chatAction("updateSession", sessionId)
        require(graph.sync.canInvokeRemoteAction(action)) { "This machine does not allow changing the model" }
        graph.sync.sendCommand(action, buildJsonObject {
            put("sessionId", sessionId)
            put("modelId", modelId)
            put("reasoningEffort", effort?.trim()?.takeIf(String::isNotEmpty))
            put("fastMode", fastMode)
        })
        // The host has accepted these values, so update the cache directly rather
        // than spending another chat.getSummary round-trip to read them back.
        sessionModelSettings[sessionId] = SessionModelSettings(modelId, effort, fastMode)
        _ui.update { it.copy(
            sessions = applySessionModels(it.sessions),
            personalChats = applySessionModels(it.personalChats),
        ) }
        pushModelRecent(modelId)
    }

    fun createFromHub(
        project: MobileProject,
        laneId: String?,
        prompt: String,
        cli: Boolean,
        model: UiModel?,
        permissionMode: String,
        reasoningEffort: String?,
        attachmentUri: Uri?,
    ) = launchBusy {
        var targetLaneId = laneId
        if (targetLaneId == null) {
            val lane = graph.sync.sendCommand(
                "lanes.create",
                buildJsonObject { put("name", fallbackLaneName(prompt)) },
                project.id,
                project.rootPath,
            ).jsonObject
            targetLaneId = lane.string("id") ?: error("The machine did not return the new lane")
        }
        val attachmentPath = if (!cli && attachmentUri != null) {
            val (filename, mimeType, bytes) = readAttachment(attachmentUri)
            graph.sync.sendCommand("chat.saveTempAttachment", buildJsonObject {
                put("filename", filename)
                put("dataUrl", "data:$mimeType;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}")
            }, project.id, project.rootPath).jsonObject.string("path")
                ?: error("The machine did not save the attachment")
        } else null
        if (cli) {
            graph.sync.sendCommand("work.startCliSession", buildJsonObject {
                put("laneId", targetLaneId)
                put("provider", model?.provider ?: "codex")
                put("permissionMode", permissionMode)
                put("initialInput", prompt)
                model?.let {
                    put("model", it.runtimeModelId)
                    put("modelId", it.id)
                }
                if (!reasoningEffort.isNullOrBlank()) put("reasoningEffort", reasoningEffort)
            }, project.id, project.rootPath)
        } else {
            val created = graph.sync.sendCommand("chat.create", buildJsonObject {
                put("laneId", targetLaneId)
                put("provider", model?.provider ?: "codex")
                put("model", model?.runtimeModelId.orEmpty())
                model?.let { put("modelId", it.id) }
                put("permissionMode", permissionMode)
                if (!reasoningEffort.isNullOrBlank()) put("reasoningEffort", reasoningEffort)
            }, project.id, project.rootPath).jsonObject
            val sessionId = created.string("sessionId") ?: created.string("id")
                ?: error("The machine did not return the new chat")
            graph.sync.sendCommand("chat.send", buildJsonObject {
                put("sessionId", sessionId)
                put("text", prompt.ifBlank { if (attachmentPath != null) "See attached image." else error("Write a message first") })
                if (attachmentPath != null) putJsonArray("attachments") {
                    add(buildJsonObject {
                        put("path", attachmentPath)
                        put("type", "image")
                    })
                }
            }, project.id, project.rootPath)
        }
        graph.sync.requestRosterSnapshot()
        AdeConnectionService.start(getApplication(), currentMachine()?.name)
        setHubComposerDraft("")
    }

    fun setHubCollapsed(projectId: String, collapsed: Boolean) {
        val next = _ui.value.hubCollapsedProjectIds.toMutableSet().apply {
            if (collapsed) add(projectId) else remove(projectId)
        }
        _ui.update { it.copy(hubCollapsedProjectIds = next) }
        persistHubState { machineKey -> graph.preferences.setHubCollapsed(machineKey, next.joinToString("\n")) }
    }

    fun setHubLaneCollapsed(projectId: String, laneId: String, collapsed: Boolean) {
        val key = "$projectId:$laneId"
        val next = _ui.value.hubCollapsedLaneKeys.toMutableSet().apply {
            if (collapsed) add(key) else remove(key)
        }
        _ui.update { it.copy(hubCollapsedLaneKeys = next) }
        persistHubState { machineKey -> graph.preferences.setHubCollapsedLanes(machineKey, next.joinToString("\n")) }
    }

    /**
     * Collapse state for a Work tab group. [scope] is the project id; [id] is the
     * group id (lane id, status bucket, or time bucket). Stored under its own
     * DataStore key so it never collides with the Hub's lane collapse set.
     */
    fun setWorkCollapsed(scope: String, id: String, collapsed: Boolean) {
        val key = "$scope:$id"
        val next = _ui.value.workCollapsedKeys.toMutableSet().apply {
            if (collapsed) add(key) else remove(key)
        }
        _ui.update { it.copy(workCollapsedKeys = next) }
        persistHubState { machineKey -> graph.preferences.setWorkCollapsed(machineKey, next.joinToString("\n")) }
    }

    fun setWorkViewState(scope: String, value: WorkViewState) {
        val next = _ui.value.workViewStates + (scope to value)
        _ui.update { it.copy(workViewStates = next) }
        persistHubState { machineKey ->
            graph.preferences.setWorkViewState(
                machineKey,
                json.encodeToString(MapSerializer(String.serializer(), WorkViewState.serializer()), next),
            )
        }
    }

    /**
     * Creates a lane through `lanes.create` (apps/desktop/src/shared/types/lanes.ts
     * CreateLaneArgs). When [baseRef] is blank the host resolves the project's
     * configured new-lane base itself, so we deliberately omit the field.
     */
    fun createLane(name: String, baseRef: String? = null) = launchBusy {
        require(graph.sync.canInvokeRemoteAction("lanes.create")) { "This machine does not allow creating lanes" }
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "Name the lane first" }
        graph.sync.sendCommand("lanes.create", buildJsonObject {
            put("name", trimmed)
            baseRef?.trim()?.takeIf(String::isNotEmpty)?.let { put("baseBranch", it) }
        })
        refreshLanesNow()
    }

    fun setHubComposerDraft(value: String) {
        _ui.update { it.copy(hubComposerDraft = value) }
        persistHubState { machineKey -> graph.preferences.setComposerDraft(machineKey, value) }
    }

    fun setHubComposerPreferences(value: HubComposerPreferences) {
        _ui.update { it.copy(hubComposerPreferences = value) }
        persistHubState { machineKey ->
            graph.preferences.setComposerPreferences(
                machineKey,
                json.encodeToString(HubComposerPreferences.serializer(), value),
            )
        }
    }

    fun setHubProjectOrder(ids: List<String>) {
        val next = ids.distinct()
        _ui.update { it.copy(hubProjectOrder = next) }
        persistHubState { machineKey -> graph.preferences.setHubOrder(machineKey, next.joinToString("\n")) }
    }

    fun loadProjectAddSheet() = launchQuiet {
        val parentResponse = graph.sync.request("project_default_parent_dir_request")
        val parent = (parentResponse as? JsonObject)?.string("parentDir").orEmpty()
        _ui.update { it.copy(projectDefaultParent = parent) }
        if (parent.isNotBlank()) browseProjectDirectoriesNow(parent)
        listGitHubReposNow("")
    }

    fun browseProjectDirectories(path: String) = launchBusy { browseProjectDirectoriesNow(path) }

    fun listGitHubRepos(search: String) = launchQuiet { listGitHubReposNow(search) }

    fun openMachineProject(rootPath: String, onSuccess: (MobileProject) -> Unit) = launchBusy {
        onSuccess(projectAction("project_open_request", buildJsonObject { put("rootPath", rootPath) }, 120_000))
    }

    fun createMachineProject(name: String, parentDir: String, onSuccess: (MobileProject) -> Unit) = launchBusy {
        onSuccess(projectAction("project_create_request", buildJsonObject {
            put("name", name.trim())
            put("parentDir", parentDir.trim())
        }, 120_000))
    }

    fun cloneMachineProject(url: String, name: String, parentDir: String, onSuccess: (MobileProject) -> Unit) = launchBusy {
        onSuccess(projectAction("project_clone_request", buildJsonObject {
            put("url", url.trim())
            if (name.isNotBlank()) put("name", name.trim())
            put("parentDir", parentDir.trim())
        }, 300_000))
    }

    fun openProject(project: MobileProject, onSuccess: () -> Unit) = launchBusy {
        _ui.update { it.copy(openingProjectName = project.displayName) }
        try {
            switchProjectNow(project)
            onSuccess()
            // The project switch is the navigation contract. Personal chats,
            // model catalogs, account attention, and even lane status can each
            // involve independent network work; none should hold the user on
            // the Hub after the host has already accepted the project.
            launchQuiet {
                refreshAllNow()
                resumeSelectedStream()
            }
        } finally {
            _ui.update { it.copy(openingProjectName = null) }
        }
    }

    fun openRosterSession(project: MobileProject, sessionId: String, onSuccess: (UiSession) -> Unit) = launchBusy {
        _ui.update { it.copy(openingProjectName = project.displayName) }
        try {
            switchProjectNow(project)
            refreshAllNow()
            val session = _ui.value.sessions.firstOrNull { it.id == sessionId }
                ?: error("That session is no longer available in ${project.displayName}")
            onSuccess(session)
        } finally {
            _ui.update { it.copy(openingProjectName = null) }
        }
    }

    fun openDeepLinkSession(sessionId: String, accountMachineKey: String?, onSuccess: (UiSession) -> Unit) {
        val current = currentMachine()
        val machineMatches = accountMachineKey == null ||
            accountMachineKey == current?.machineKey || accountMachineKey == current?.accountMachineKey
        if (machineMatches) _ui.value.sessions.firstOrNull { it.id == sessionId }?.let {
            onSuccess(it)
            return
        }
        launchBusy {
            if (!machineMatches) {
                val profile = resolveAccountMachineProfile(requireNotNull(accountMachineKey))
                    ?: error("Pair this notification's machine before opening its session")
                loadCache(profile.machineKey)
                graph.pairing.connect(profile)
                refreshAllNow()
                _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
            }
            val rosterProject = awaitRosterProjectForSession(sessionId)
                ?: error("That session is no longer available on this machine")
            val project = graph.sync.catalog.value.projects.firstOrNull { it.id == rosterProject.projectId }
                ?: MobileProject(
                    id = rosterProject.projectId,
                    displayName = rosterProject.displayName,
                    rootPath = rosterProject.rootPath,
                )
            switchProjectNow(project)
            refreshAllNow()
            val session = _ui.value.sessions.firstOrNull { it.id == sessionId }
                ?: error("That session is no longer available in ${project.displayName}")
            onSuccess(session)
        }
    }

    private suspend fun switchProjectNow(project: MobileProject) {
        val result = graph.sync.request("project_switch_request", buildJsonObject {
            put("projectId", project.id)
            if (project.rootPath != null) put("rootPath", project.rootPath)
        }).jsonObject
        if (result["ok"]?.jsonPrimitive?.content != "true") {
            error(result.string("message") ?: "The machine could not open this project")
        }
        if (result["connection"] != null && result["connection"] !is JsonNull) {
            graph.pairing.reconnectProject(result["connection"]!!.jsonObject)
        }
        graph.sync.selectProject(project.id, project.rootPath)
    }

    private suspend fun awaitRosterProjectForSession(sessionId: String): RosterProject? {
        findRosterProjectForSession(graph.sync.roster.value, sessionId)?.let { return it }
        graph.sync.requestRosterSnapshot(null)
        val snapshot = withTimeoutOrNull(8_000) {
            graph.sync.roster.filterNotNull().first { roster ->
                findRosterProjectForSession(roster, sessionId) != null
            }
        } ?: return null
        return findRosterProjectForSession(snapshot, sessionId)
    }

    private suspend fun resolveAccountMachineProfile(accountMachineKey: String): MachineProfile? {
        graph.machineStore.findForAccountMachine(accountMachineKey)?.let { return it }
        val directoryMachine = _ui.value.machines.firstOrNull { it.machineKey == accountMachineKey }
            ?: runCatching { graph.directory.machines().firstOrNull { it.machineKey == accountMachineKey } }.getOrNull()
            ?: return null
        val hostDeviceId = directoryMachine.deviceId ?: return null
        val profile = graph.machineStore.list().firstOrNull { it.hostDeviceId == hostDeviceId } ?: return null
        val mapped = profile.copy(accountMachineKey = accountMachineKey)
        graph.machineStore.put(mapped)
        return mapped
    }

    private fun reconcileDirectoryMachineMappings(machines: List<DirectoryMachine>) {
        graph.machineStore.list().forEach { profile ->
            val directory = machines.firstOrNull(profile::matches) ?: return@forEach
            if (profile.accountMachineKey != directory.machineKey) {
                graph.machineStore.put(profile.copy(accountMachineKey = directory.machineKey))
            }
        }
    }

    fun runLaneAction(action: String, laneId: String) = launchBusy {
        graph.sync.sendCommand(action, buildJsonObject { put("laneId", laneId) })
        refreshLanes()
    }

    fun runSessionAction(action: String, sessionId: String) = launchBusy {
        graph.sync.sendCommand(action, buildJsonObject { put("sessionId", sessionId) })
        refreshSessionsNow()
        graph.sync.requestRosterSnapshot()
    }

    fun runRosterSessionAction(action: String, project: MobileProject, sessionId: String) = launchBusy {
        graph.sync.sendCommand(
            action,
            buildJsonObject { put("sessionId", sessionId) },
            project.id,
            project.rootPath,
        )
        graph.sync.requestRosterSnapshot()
        if (graph.sync.hasSelectedProject()) refreshSessionsNow()
    }

    fun refreshLaneDetail(laneId: String) = launchQuiet {
        if (!graph.sync.canInvokeRemoteAction("lanes.getDetail")) return@launchQuiet
        val detail = graph.sync.sendCommand("lanes.getDetail", buildJsonObject { put("laneId", laneId) }).jsonObject
        _ui.update { it.copy(laneDetails = it.laneDetails + (laneId to detail)) }
    }

    fun renameLane(laneId: String, name: String) = launchBusy {
        graph.sync.sendCommand("lanes.rename", buildJsonObject {
            put("laneId", laneId)
            put("name", name.trim())
        })
        refreshLanesNow()
        refreshLaneDetail(laneId)
    }

    fun canInvoke(action: String): Boolean = graph.sync.canInvokeRemoteAction(action)

    fun refreshLanes() = launchQuiet {
        if (!graph.sync.hasSelectedProject()) return@launchQuiet
        if (!graph.sync.canInvokeRemoteAction("lanes.refreshSnapshots")) return@launchQuiet
        // `refreshLanes` is fire-and-forget, so overlapping callers would
        // otherwise put several full lane-status sweeps on the wire at once and
        // let the slower reply overwrite the fresher one in `_ui.lanes`. One in
        // flight is always enough: the next invalidation re-runs it.
        if (!laneRefreshInFlight.compareAndSet(false, true)) return@launchQuiet
        try {
            val result = graph.sync.sendCommand(
                "lanes.refreshSnapshots",
                buildJsonObject { put("includeStatus", true) },
            )
            val lanes = parseLanes(result)
            _ui.update { it.copy(lanes = lanes) }
            cache("lanes", result)
        } finally {
            laneRefreshInFlight.set(false)
        }
    }

    fun refreshSessions() = launchQuiet {
        if (!graph.sync.hasSelectedProject()) return@launchQuiet
        if (!graph.sync.canInvokeRemoteAction("work.listSessions")) return@launchQuiet
        val result = graph.sync.sendCommand("work.listSessions")
        val sessions = applySessionModels(parseSessions(result))
        _ui.update { it.copy(sessions = sessions) }
        reconcileForegroundService(sessions + _ui.value.personalChats)
        cache("sessions", result)
    }

    fun refreshPersonalChats() = launchQuiet { refreshPersonalChatsNow() }

    fun createPersonalChat(
        prompt: String,
        model: UiModel?,
        permissionMode: String,
        reasoningEffort: String?,
        onSuccess: (UiSession) -> Unit,
    ) = launchBusy {
        require(prompt.isNotBlank()) { "Write a message first" }
        val result = graph.sync.sendCommand("personalChats.create", buildJsonObject {
            put("provider", model?.provider ?: "codex")
            put("model", model?.runtimeModelId.orEmpty())
            model?.let { put("modelId", it.id) }
            put("kickoffText", prompt.trim())
            put("permissionMode", permissionMode)
            if (!reasoningEffort.isNullOrBlank()) put("reasoningEffort", reasoningEffort)
        })
        val session = parsePersonalChats(JsonArray(listOf(result))).firstOrNull()
            ?: error("The machine did not return the new personal chat")
        refreshPersonalChatsNow()
        AdeConnectionService.start(getApplication(), currentMachine()?.name)
        onSuccess(session)
    }

    fun runPersonalChatAction(action: String, sessionId: String) = launchBusy {
        graph.sync.sendCommand("personalChats.$action", buildJsonObject { put("sessionId", sessionId) })
        refreshPersonalChatsNow()
    }

    fun canInvokeChat(action: String, personal: Boolean): Boolean =
        graph.sync.canInvokeRemoteAction(if (personal) "personalChats.$action" else when (action) {
            "getEventHistoryPage" -> "chat.getChatEventHistoryPage"
            else -> "chat.$action"
        })

    fun refreshQuota() = launchQuiet {
        if (!graph.sync.canInvokeRemoteAction("usage.refreshQuota")) return@launchQuiet
        _ui.update { it.copy(quota = graph.sync.sendCommand("usage.refreshQuota")) }
    }

    fun refreshModelCatalog() = launchQuiet { refreshModelCatalogNow() }

    // -----------------------------------------------------------------------
    // Model picker favourites + recents
    //
    // The host owns these when it registers the `modelPicker.*` remote commands
    // (`modelPicker.getFavorites` / `toggleFavorite` / `getRecents` / `pushRecent`
    // in syncRemoteCommandService.ts) — the same cr-sqlite store iOS and desktop
    // share. Hosts that predate those commands fall back to the DataStore keys in
    // AppPreferences, which also act as the cold-start mirror so the picker is not
    // empty before the first round-trip.
    // -----------------------------------------------------------------------

    fun toggleModelFavourite(modelId: String) = launchQuiet {
        val next = _ui.value.modelFavourites.toMutableSet().apply {
            if (!add(modelId)) remove(modelId)
        }.toSet()
        _ui.update { it.copy(modelFavourites = next) }
        persistModelPickerState()
        if (graph.sync.canInvokeRemoteAction("modelPicker.toggleFavorite")) {
            runCatching {
                graph.sync.sendCommand("modelPicker.toggleFavorite", buildJsonObject { put("modelId", modelId) })
            }
            refreshModelPickerStateNow()
        }
    }

    private suspend fun pushModelRecent(modelId: String) {
        val next = (listOf(modelId) + _ui.value.modelRecents.filterNot { it == modelId }).take(MODEL_RECENTS_LIMIT)
        _ui.update { it.copy(modelRecents = next) }
        persistModelPickerState()
        if (graph.sync.canInvokeRemoteAction("modelPicker.pushRecent")) {
            runCatching {
                graph.sync.sendCommand("modelPicker.pushRecent", buildJsonObject { put("modelId", modelId) })
            }
            refreshModelPickerStateNow()
        }
    }

    private suspend fun refreshModelPickerStateNow() {
        if (graph.sync.canInvokeRemoteAction("modelPicker.getFavorites")) {
            runCatching { graph.sync.sendCommand("modelPicker.getFavorites") }.getOrNull()?.let { result ->
                stringList(result, "favorites")?.let { favorites ->
                    _ui.update { it.copy(modelFavourites = favorites.toSet()) }
                }
            }
        }
        if (graph.sync.canInvokeRemoteAction("modelPicker.getRecents")) {
            runCatching { graph.sync.sendCommand("modelPicker.getRecents") }.getOrNull()?.let { result ->
                stringList(result, "recents")?.let { recents ->
                    _ui.update { it.copy(modelRecents = recents.take(MODEL_RECENTS_LIMIT)) }
                }
            }
        }
        persistModelPickerState()
    }

    private fun stringList(result: JsonElement, key: String): List<String>? =
        ((result as? JsonObject)?.get(key) as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }

    private fun persistModelPickerState() {
        val state = _ui.value
        persistHubState { machineKey ->
            graph.preferences.setModelFavourites(machineKey, state.modelFavourites.sorted().joinToString("\n"))
            graph.preferences.setModelRecents(machineKey, state.modelRecents.joinToString("\n"))
        }
    }

    fun toggleSessionMute(sessionId: String) = launchBusy {
        val current = _ui.value.attentionPreferences ?: JsonObject(emptyMap())
        val muted = (current["mutedSessionIds"] as? JsonArray).orEmpty()
            .mapNotNull { it.jsonPrimitive.contentOrNull }.toMutableSet()
        if (!muted.add(sessionId)) muted.remove(sessionId)
        val next = JsonObject(current.toMutableMap().apply {
            put("mutedSessionIds", JsonArray(muted.sorted().map { JsonPrimitive(it) }))
        })
        graph.attention.putPreferences(next)
        _ui.update { it.copy(attentionPreferences = next) }
    }

    fun setAttentionAccountFlag(key: String, enabled: Boolean) = launchBusy {
        val current = _ui.value.attentionPreferences ?: JsonObject(emptyMap())
        val account = current["account"] as? JsonObject ?: JsonObject(emptyMap())
        val nextAccount = JsonObject(account.toMutableMap().apply { put(key, JsonPrimitive(enabled)) })
        val next = JsonObject(current.toMutableMap().apply { put("account", nextAccount) })
        val response = graph.attention.putPreferences(next)
        _ui.update { it.copy(
            attentionPreferences = response["preferences"] as? JsonObject ?: next,
        ) }
    }

    fun refreshAttention() = launchQuiet { refreshAttentionNow() }

    fun setAttentionDrawerVisible(visible: Boolean) {
        attentionDrawerVisible = visible
        launchQuiet { sendAttentionPresence() }
    }

    fun setAppForeground(foreground: Boolean) {
        appForeground = foreground
        if (foreground) {
            if (graph.sync.status.value.state != "connected") startAutoReconnect()
        } else {
            // Backgrounded: stop retrying in-process. WorkManager owns backoff
            // from here, because it can wait without the app holding anything.
            autoReconnectJob?.cancel()
            autoReconnectJob = null
            if (_ui.value.reconnecting) _ui.update { it.copy(reconnecting = false) }
        }
        launchQuiet {
            sendAttentionPresence()
            if (foreground && graph.sync.status.value.state == "connected") resumeSelectedStream()
        }
    }

    /**
     * Retries a dropped connection while the app is in the foreground.
     *
     * Bounded exponential backoff, no wake lock, and every attempt goes through
     * `PairingRepository.connect`, which serialises against the WorkManager
     * path and short-circuits when a connection is already live — so this
     * cannot reintroduce duplicate concurrent reconnects. Once the in-process
     * budget is spent the retry is handed to `ReconnectWorker`.
     */
    private fun startAutoReconnect() {
        if (!appForeground) return
        if (autoReconnectJob?.isActive == true) return
        val profile = currentMachine() ?: return
        autoReconnectJob = viewModelScope.launch {
            var attempt = 0
            _ui.update { it.copy(reconnecting = true) }
            try {
                while (isActive && appForeground && attempt < FOREGROUND_RECONNECT_ATTEMPTS) {
                    if (graph.sync.status.value.state == "connected") return@launch
                    val backoff = (FOREGROUND_RECONNECT_BASE_MS shl attempt)
                        .coerceAtMost(FOREGROUND_RECONNECT_MAX_MS)
                    delay(backoff)
                    attempt += 1
                    if (!appForeground) return@launch
                    if (graph.sync.status.value.state == "connected") return@launch
                    val reconnected = runCatching { graph.pairing.connect(profile) }.isSuccess
                    if (reconnected) {
                        _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
                        runCatching {
                            refreshAllNow()
                            resumeSelectedStream()
                        }
                        return@launch
                    }
                }
                if (appForeground) ReconnectWorker.enqueue(getApplication())
            } finally {
                _ui.update { it.copy(reconnecting = false) }
            }
        }
    }

    fun dismissAttention(itemId: String) = launchBusy {
        graph.attention.acknowledge(listOf(itemId), dismiss = true)
        _ui.update { state -> state.copy(attentionItems = state.attentionItems.filterNot { it.string("id") == itemId }) }
        refreshAttentionNow()
    }

    fun markAttentionSeen(itemId: String) = launchQuiet {
        graph.attention.acknowledge(listOf(itemId), dismiss = false)
        refreshAttentionNow()
    }

    fun sendTerminalInput(text: String) {
        val id = _ui.value.selectedSessionId ?: return
        runCatching { graph.sync.sendTerminalInput(id, text) }.onFailure { error ->
            _ui.update { it.copy(error = error.message ?: "Terminal input could not be sent") }
        }
    }

    fun resizeTerminal(rows: Int, columns: Int) {
        val id = _ui.value.selectedSessionId ?: return
        if (BuildConfig.DEBUG) android.util.Log.d("AdeTerminal", "resize session=$id cols=$columns rows=$rows")
        runCatching { graph.sync.resizeTerminal(id, columns, rows) }
    }

    fun setAppearance(value: Appearance) = viewModelScope.launch { graph.preferences.setAppearance(value) }
    fun setAnalyticsEnabled(value: Boolean) = viewModelScope.launch {
        graph.preferences.setAnalyticsEnabled(value)
        runCatching { reconcileAnalyticsPreference(value) }.onFailure { error ->
            if (!value) graph.sync.disconnect()
            _ui.update {
                it.copy(error = if (value) {
                    "Analytics will resume when ADE reconnects."
                } else {
                    error.message ?: "ADE disconnected to enforce the analytics opt-out."
                })
            }
        }
    }

    fun captureScreen(screen: String) {
        if (screen !in ANALYTICS_SCREENS) return
        viewModelScope.launch {
            runCatching {
                captureAnalytics(
                    event = "ade_screen_viewed",
                    properties = buildJsonObject { put("screen", screen) },
                    dedupeKey = "android_screen:$screen",
                    minimumIntervalMs = 2_000,
                )
            }
        }
    }
    fun setPushEnabled(value: Boolean) = viewModelScope.launch {
        graph.preferences.setPushEnabled(value)
        if (_ui.value.signedIn) runCatching { updatePushRegistration(value) }
            .onFailure { error -> _ui.update { it.copy(error = error.message ?: "Push registration failed") } }
    }

    fun handleDeepLink(uri: Uri?) {
        if (uri?.scheme == "https" && uri.host == "ade-app.dev" && uri.path?.endsWith("/pair") == true) {
            if (setPairingText(uri.toString())) {
                _ui.update { it.copy(deepLinkSequence = it.deepLinkSequence + 1, deepLinkSessionId = null) }
            }
            return
        }
        val sessionId = when {
            uri?.scheme == "https" && uri.host == "ade-app.dev" && uri.path?.endsWith("/open") == true &&
                uri.getQueryParameter("type") == "session" -> uri.getQueryParameter("id")
            uri?.scheme == "ade" && uri.host == "session" -> uri.pathSegments.firstOrNull()
            else -> null
        }?.trim()?.takeIf(String::isNotBlank)
        if (sessionId != null) {
            _ui.update { it.copy(
                deepLinkSequence = it.deepLinkSequence + 1,
                deepLinkSessionId = sessionId,
                deepLinkMachineKey = uri?.getQueryParameter("accountMachineKey")?.trim()?.takeIf(String::isNotBlank),
            ) }
        }
    }

    override fun onCleared() {
        nearby.close()
        super.onCleared()
    }

    private suspend fun refreshAllNow() {
        graph.sync.requestRosterSnapshot()
        graph.sync.requestProjectCatalog()
        refreshPersonalChatsNow()
        if (graph.sync.hasSelectedProject()) {
            refreshLanesNow()
            refreshSessionsNow()
            refreshModelCatalogNow()
        }
        if (_ui.value.signedIn) refreshAttentionNow()
        // Best-effort and only needed once the picker opens, so it goes last: it
        // must never delay lanes/sessions/transcript on a slow link.
        refreshModelPickerStateNow()
    }

    private suspend fun refreshAttentionNow() {
        val current = _ui.value
        val response = graph.attention.snapshot(current.attentionCursor, current.attentionStreamId)
        val streamId = response["streamId"]?.jsonPrimitive?.contentOrNull
        val sameStream = current.attentionStreamId == null || streamId == null || current.attentionStreamId == streamId
        val incoming = (response["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val removed = (response["tombstones"] as? JsonArray).orEmpty().mapNotNull {
            (it as? JsonObject)?.string("id")
        }.toSet()
        val merged = (if (sameStream) current.attentionItems else emptyList())
            .associateBy { it.string("id").orEmpty() }.toMutableMap()
        removed.forEach(merged::remove)
        incoming.forEach { item -> item.string("id")?.let { merged[it] = item } }
        val revision = response["revision"]?.jsonPrimitive?.contentOrNull
        val preferences = runCatching { graph.attention.preferences()["preferences"] as? JsonObject }.getOrNull()
        _ui.update { it.copy(
            attentionItems = merged.values.filter { item -> item["dismissedAt"] is JsonNull || item["dismissedAt"] == null }
                .sortedByDescending { item -> item.string("updatedAt") },
            attentionCursor = revision ?: current.attentionCursor.takeIf { sameStream },
            attentionStreamId = streamId ?: current.attentionStreamId,
            attentionPreferences = preferences,
        ) }
        sendAttentionPresence()
    }

    private suspend fun sendAttentionPresence() {
        if (!_ui.value.signedIn) return
        val visibleIds = if (appForeground && attentionDrawerVisible) {
            _ui.value.attentionItems.mapNotNull { it.string("id") }.filter(String::isNotBlank)
        } else emptyList()
        graph.attention.presence(visibleIds, foreground = appForeground)
    }

    private suspend fun updatePushRegistration(enabled: Boolean) {
        graph.attentionActionMutex.withLock {
            // The local switch remains authoritative if the remote preference
            // update fails while a previously queued FCM message is in flight.
            graph.machineStore.setLocalPushEnabled(enabled)
            val token = firebaseToken()
            val ownerId = graph.auth.userId ?: error("Sign in again to update notifications")
            graph.attention.registerFcm(token, enabled, ownerId)
        }
    }

    private suspend fun reconcileAnalyticsPreference() {
        reconcileAnalyticsPreference(graph.preferences.analyticsEnabled.first())
    }

    private suspend fun reconcileAnalyticsPreference(enabled: Boolean) {
        if (!graph.sync.canInvokeRemoteAction("analytics.setClientEnabled")) return
        graph.sync.sendCommand(
            "analytics.setClientEnabled",
            buildJsonObject { put("enabled", enabled) },
        )
    }

    private suspend fun captureAppOpenedNow() {
        captureAnalytics(
            event = "ade_app_opened",
            properties = buildJsonObject {
                put("entry_point", "remote")
                put("connection_state", "connected")
            },
            dedupeKey = "android_app_opened",
            minimumIntervalMs = 2_000,
        )
    }

    private suspend fun captureAnalytics(
        event: String,
        properties: JsonObject,
        dedupeKey: String,
        minimumIntervalMs: Int,
    ) {
        if (!graph.preferences.analyticsEnabled.first()) return
        if (!graph.sync.canInvokeRemoteAction("analytics.capture")) return
        graph.sync.sendCommand("analytics.capture", buildJsonObject {
            put("event", event)
            put("properties", properties)
            put("dedupeKey", dedupeKey)
            put("minimumIntervalMs", minimumIntervalMs)
        })
    }

    // The relay still targets FCM registration tokens. Firebase's replacement registration API
    // exposes an installation ID, so keep this compatibility path until the relay migrates too.
    @Suppress("DEPRECATION")
    private suspend fun firebaseToken(): String = suspendCancellableCoroutine { continuation ->
        com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnCompleteListener { task ->
            if (!continuation.isActive) return@addOnCompleteListener
            if (task.isSuccessful && !task.result.isNullOrBlank()) continuation.resume(task.result)
            else continuation.resumeWith(Result.failure(task.exception ?: IllegalStateException("FCM token is unavailable")))
        }
    }

    private suspend fun refreshLanesNow() {
        if (!graph.sync.hasSelectedProject()) return
        if (!graph.sync.canInvokeRemoteAction("lanes.refreshSnapshots")) return
        val result = graph.sync.sendCommand("lanes.refreshSnapshots", buildJsonObject { put("includeStatus", true) })
        _ui.update { it.copy(lanes = parseLanes(result)) }
        cache("lanes", result)
    }

    private suspend fun refreshSessionsNow() {
        if (!graph.sync.hasSelectedProject()) return
        if (!graph.sync.canInvokeRemoteAction("work.listSessions")) return
        val result = graph.sync.sendCommand("work.listSessions")
        val sessions = applySessionModels(parseSessions(result))
        _ui.update { it.copy(sessions = sessions) }
        reconcileForegroundService(sessions + _ui.value.personalChats)
        cache("sessions", result)
    }

    private suspend fun refreshPersonalChatsNow() {
        if (!graph.sync.canInvokeRemoteAction("personalChats.list")) return
        val result = graph.sync.sendCommand("personalChats.list", buildJsonObject { put("includeArchived", true) })
        val personalChats = applySessionModels(parsePersonalChats(result))
        _ui.update { it.copy(personalChats = personalChats) }
        reconcileForegroundService(_ui.value.sessions + personalChats)
        cache("personal_chats", result)
        if (graph.sync.canInvokeRemoteAction("personalChats.modelCatalog")) {
            refreshModelCatalogNow("personalChats.modelCatalog")
        }
    }

    private fun reconcileForegroundService(sessions: List<UiSession>) {
        val active = needsForegroundService(_ui.value.selectedSessionId, sessions)
        if (active && appForeground) AdeConnectionService.start(getApplication(), currentMachine()?.name)
        else if (!active) AdeConnectionService.stopForegroundOnly(getApplication())
    }

    private suspend fun refreshModelCatalogNow(action: String = "chat.modelCatalog") {
        if (action == "chat.modelCatalog" && !graph.sync.hasSelectedProject()) return
        if (!graph.sync.canInvokeRemoteAction(action)) return
        val result = graph.sync.sendCommand(action, buildJsonObject { put("mode", "cached") })
        val groups = (result as? JsonObject)?.get("groups") as? JsonArray ?: return
        val models = buildList {
            groups.forEach { groupElement ->
                val group = groupElement as? JsonObject ?: return@forEach
                (group["providers"] as? JsonArray).orEmpty().forEach { providerElement ->
                    val provider = providerElement as? JsonObject ?: return@forEach
                    (provider["subsections"] as? JsonArray).orEmpty().forEach { subsectionElement ->
                        val subsection = subsectionElement as? JsonObject ?: return@forEach
                        (subsection["models"] as? JsonArray).orEmpty().forEach { modelElement ->
                            val model = modelElement as? JsonObject ?: return@forEach
                            if (model["isAvailable"]?.jsonPrimitive?.content == "false") return@forEach
                            val id = model.string("id") ?: return@forEach
                            add(UiModel(
                                id = id,
                                runtimeModelId = model.string("runtimeModelId") ?: id,
                                name = model.string("displayName") ?: id,
                                provider = model.string("provider") ?: group.string("key") ?: "codex",
                                defaultReasoning = model.string("defaultReasoningEffort"),
                                reasoningEfforts = (model["reasoningEfforts"] as? JsonArray).orEmpty().mapNotNull { effort ->
                                    (effort as? JsonObject)?.string("effort")
                                },
                                // `serviceTiers` is a flat string array on the catalog
                                // model (see AgentChatModelCatalogModel in
                                // apps/desktop/src/shared/types/chat.ts). Fast mode is
                                // supported iff it contains "fast".
                                serviceTiers = (model["serviceTiers"] as? JsonArray).orEmpty().mapNotNull { tier ->
                                    (tier as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
                                },
                            ))
                        }
                    }
                }
            }
        }.distinctBy(UiModel::id)
        _ui.update { it.copy(models = models) }
    }

    private suspend fun loadCache(machineKey: String) {
        _ui.update { it.copy(
            lanes = emptyList(),
            laneDetails = emptyMap(),
            sessions = emptyList(),
            personalChats = emptyList(),
            selectedSessionId = null,
            transcript = emptyList(),
            terminalData = "",
        ) }
        val cachedRoster = graph.preferences.cached(machineKey, "roster").first()?.let { raw ->
            runCatching { json.decodeFromString(RosterSnapshot.serializer(), raw) }.getOrNull()
        }
        val cachedCatalog = graph.preferences.cached(machineKey, "catalog").first()?.let { raw ->
            runCatching { json.decodeFromString(com.ade.sync.model.ProjectCatalog.serializer(), raw) }.getOrNull()
        }
        graph.sync.seedCached(cachedRoster, cachedCatalog)
        graph.preferences.cached(machineKey, "lanes").first()?.let { raw ->
            runCatching { json.parseToJsonElement(raw) }.onSuccess { result ->
                _ui.update { it.copy(lanes = parseLanes(result)) }
            }
        }
        graph.preferences.cached(machineKey, "sessions").first()?.let { raw ->
            runCatching { json.parseToJsonElement(raw) }.onSuccess { result ->
                _ui.update { it.copy(sessions = parseSessions(result)) }
            }
        }
        graph.preferences.cached(machineKey, "personal_chats").first()?.let { raw ->
            runCatching { json.parseToJsonElement(raw) }.onSuccess { result ->
                _ui.update { it.copy(personalChats = parsePersonalChats(result)) }
            }
        }
        val collapsed = graph.preferences.hubCollapsed(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toSet()
        val collapsedLanes = graph.preferences.hubCollapsedLanes(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toSet()
        val order = graph.preferences.hubOrder(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toList()
        val draft = graph.preferences.composerDraft(machineKey).first()
        val composerPreferences = graph.preferences.composerPreferences(machineKey).first()?.let { raw ->
            runCatching { json.decodeFromString(HubComposerPreferences.serializer(), raw) }.getOrNull()
        } ?: HubComposerPreferences()
        val workCollapsed = graph.preferences.workCollapsed(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toSet()
        val modelFavourites = graph.preferences.modelFavourites(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toSet()
        val modelRecents = graph.preferences.modelRecents(machineKey).first().orEmpty()
            .lineSequence().filter(String::isNotBlank).toList()
        val workViewStates = graph.preferences.workViewState(machineKey).first()?.let { raw ->
            runCatching {
                json.decodeFromString(MapSerializer(String.serializer(), WorkViewState.serializer()), raw)
            }.getOrNull()
        }.orEmpty()
        _ui.update { it.copy(
            hubCollapsedProjectIds = collapsed,
            hubCollapsedLaneKeys = collapsedLanes,
            hubProjectOrder = order,
            hubComposerDraft = draft,
            hubComposerPreferences = composerPreferences,
            workCollapsedKeys = workCollapsed,
            workViewStates = workViewStates,
            modelFavourites = modelFavourites,
            modelRecents = modelRecents,
        ) }
    }

    private suspend fun browseProjectDirectoriesNow(path: String) {
        val response = graph.sync.request("project_browse_request", buildJsonObject {
            put("partialPath", path.trim())
            put("limit", 80)
        }).jsonObject
        require(response["ok"]?.jsonPrimitive?.content == "true") {
            response.string("message") ?: "The machine could not browse that folder"
        }
        val result = response["result"] as? JsonObject ?: error("The machine returned no folder listing")
        val entries = (result["entries"] as? JsonArray).orEmpty().mapNotNull { element ->
            val entry = element as? JsonObject ?: return@mapNotNull null
            val fullPath = entry.string("fullPath") ?: return@mapNotNull null
            UiProjectBrowseEntry(
                name = entry.string("name") ?: fullPath.substringAfterLast('/'),
                fullPath = fullPath,
                gitRepository = entry["isGitRepo"]?.jsonPrimitive?.content == "true",
            )
        }
        _ui.update { it.copy(
            projectDefaultParent = result.string("directoryPath") ?: path,
            projectBrowseEntries = entries,
        ) }
    }

    private suspend fun listGitHubReposNow(search: String) {
        val response = graph.sync.request("project_list_my_github_repos_request", buildJsonObject {
            if (search.isNotBlank()) put("search", search.trim())
        }).jsonObject
        if (response["ok"]?.jsonPrimitive?.content != "true") return
        val repos = ((response["result"] as? JsonObject)?.get("repos") as? JsonArray).orEmpty().mapNotNull { element ->
            val repo = element as? JsonObject ?: return@mapNotNull null
            UiGitHubRepo(
                fullName = repo.string("fullName") ?: return@mapNotNull null,
                cloneUrl = repo.string("cloneUrl") ?: return@mapNotNull null,
                private = repo["isPrivate"]?.jsonPrimitive?.content == "true",
            )
        }
        _ui.update { it.copy(githubRepos = repos) }
    }

    private suspend fun projectAction(type: String, payload: JsonObject, timeout: Long): MobileProject {
        val response = graph.sync.request(type, payload, timeoutMillis = timeout).jsonObject
        require(response["ok"]?.jsonPrimitive?.content == "true") {
            response.string("message") ?: "The machine could not finish that project action"
        }
        val project = response["project"] ?: error("The machine returned no project")
        val parsed = json.decodeFromJsonElement(MobileProject.serializer(), project)
        graph.sync.requestProjectCatalog()
        return parsed
    }

    private fun persistHubState(block: suspend (String) -> Unit) {
        val machineKey = graph.machineStore.current()?.machineKey ?: return
        viewModelScope.launch { block(machineKey) }
    }

    private suspend fun cache(domain: String, value: JsonElement) {
        val key = graph.machineStore.current()?.machineKey ?: return
        graph.preferences.cache(key, domain, value.toString())
    }

    private suspend fun readAttachment(uri: Uri): Triple<String, String, ByteArray> = withContext(Dispatchers.IO) {
        val resolver = getApplication<Application>().contentResolver
        val filename = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }?.takeIf(String::isNotBlank) ?: "android-attachment"
        val mimeType = resolver.getType(uri)?.takeIf { it.startsWith("image/") }
            ?: error("Android v1 supports image attachments only")
        val bytes = resolver.openInputStream(uri)?.use { it.readNBytes(MAX_ATTACHMENT_BYTES + 1) }
            ?: error("The selected attachment could not be read")
        require(bytes.size <= MAX_ATTACHMENT_BYTES) { "Attachments must be 12 MB or smaller" }
        Triple(filename, mimeType, bytes)
    }

    private fun parsePersonalChats(result: JsonElement): List<UiSession> =
        (result as? JsonArray).orEmpty().mapNotNull { item ->
            val source = item as? JsonObject ?: return@mapNotNull null
            val id = source.string("sessionId") ?: source.string("id") ?: return@mapNotNull null
            UiSession(
                id = id,
                laneId = null,
                laneName = null,
                title = source.string("title") ?: "New chat",
                provider = source.string("provider"),
                toolType = source.string("toolType") ?: "${source.string("provider") ?: "agent"}-chat",
                runtimeState = source.string("status"),
                preview = source.string("lastOutputPreview") ?: source.string("preview"),
                pendingInputItemId = source.string("pendingInputItemId"),
                kind = SessionKind.CHAT,
                personal = true,
                archived = source["archivedAt"] != null && source["archivedAt"] !is JsonNull,
                model = source.string("model"),
            )
        }.sortedWith(
            compareBy<UiSession> { it.archived }
                .thenByDescending { it.pendingInputItemId != null || it.runtimeState == "awaiting-input" }
                .thenBy { it.title.lowercase() },
        )

    private fun appendSnapshotEvents(payload: JsonElement) {
        val source = payload as? JsonObject ?: return
        val sessionId = source.string("sessionId") ?: return
        if (sessionId != _ui.value.selectedSessionId) return
        val events = (source["events"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .map(::normalizeChatEventEnvelope)
        val resumed = source["resumed"]?.jsonPrimitive?.content == "true"
        val offset = source["tailStartOffset"]?.jsonPrimitive?.content?.toLongOrNull()
        val hasMore = source["hasOlderHistory"]?.jsonPrimitive?.content == "true" && (offset ?: 0) > 0
        // An authoritative snapshot does not prove continuity with the prior
        // host stream. Its event `sequence` values belong to the transcript,
        // not the host-assigned resumable `seq`, so the latter must reset.
        if (!resumed) chatSequenceBySession.remove(sessionId)
        _ui.update { it.copy(
            transcript = if (resumed) it.transcript else events,
            historyStartOffset = offset,
            historyHasMore = hasMore,
        ) }
    }

    private fun appendChatEvent(payload: JsonElement) {
        val source = payload as? JsonObject ?: return
        val sessionId = source.string("sessionId") ?: return
        if (sessionId != _ui.value.selectedSessionId) return
        val seq = source["seq"]?.jsonPrimitive?.content?.toLongOrNull()
        if (seq != null && seq <= (chatSequenceBySession[sessionId] ?: Long.MIN_VALUE)) return
        if (seq != null) chatSequenceBySession[sessionId] = seq
        _ui.update { state -> state.copy(transcript = (state.transcript + normalizeChatEventEnvelope(source)).takeLast(1_000)) }
    }

    private fun resumeSelectedStream() {
        val sessionId = _ui.value.selectedSessionId ?: return
        val session = selectedSession(sessionId) ?: return
        if (session.kind == SessionKind.CHAT) {
            graph.sync.subscribeChat(
                sessionId,
                chatSequenceBySession[sessionId],
                chatScope = if (session.personal) "personal" else null,
            )
        } else {
            graph.sync.subscribeTerminal(sessionId, _ui.value.terminalEndOffset)
        }
    }

    private fun selectedSession(sessionId: String): UiSession? =
        _ui.value.sessions.firstOrNull { it.id == sessionId }
            ?: _ui.value.personalChats.firstOrNull { it.id == sessionId }

    private fun chatAction(action: String, sessionId: String): String {
        val personal = selectedSession(sessionId)?.personal == true
        return if (personal) "personalChats.$action" else when (action) {
            "getEventHistoryPage" -> "chat.getChatEventHistoryPage"
            else -> "chat.$action"
        }
    }

    private fun applyTerminal(payload: JsonElement, replace: Boolean) {
        val source = payload as? JsonObject ?: return
        if (source.string("sessionId") != _ui.value.selectedSessionId) return
        _ui.update { state ->
            val merged = mergeTerminalPayload(state.terminalTranscript(), source, replace)
            state.copy(
                terminalData = merged.data,
                terminalStartOffset = merged.startOffset,
                terminalEndOffset = merged.endOffset,
                terminalAtStart = merged.atStart,
            )
        }
    }

    private fun fallbackLaneName(prompt: String): String = prompt.lowercase()
        .replace(Regex("[^a-z0-9]+"), "-").trim('-').take(42).ifBlank { "android-${UUID.randomUUID().toString().take(8)}" }

    private fun launchBusy(block: suspend () -> Unit) {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            runCatching { block() }
                .onFailure { error -> _ui.update { it.copy(error = error.message ?: "Something went wrong") } }
            _ui.update { it.copy(loading = false) }
        }
    }

    private fun launchQuiet(block: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { block() }.onFailure { error ->
                _ui.update { it.copy(error = error.message ?: "Refresh failed") }
            }
        }
    }

    companion object {
        private const val MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
        /** Collapses invalidation bursts so refreshes cannot feed themselves. */
        private const val INVALIDATION_REFRESH_DEBOUNCE_MS = 750L
        private const val FOREGROUND_RECONNECT_ATTEMPTS = 6
        private const val FOREGROUND_RECONNECT_BASE_MS = 1_000L
        private const val FOREGROUND_RECONNECT_MAX_MS = 20_000L
        /** Matches MODEL_PICKER_MAX_RECENTS in apps/ade-cli/src/services/modelPickerStore.ts. */
        private const val MODEL_RECENTS_LIMIT = 10
        private val ANALYTICS_SCREENS = setOf("onboarding", "hub", "project", "chat", "personal_chats", "settings")
    }
}

internal fun needsForegroundService(selectedSessionId: String?, sessions: List<UiSession>): Boolean =
    selectedSessionId != null || sessions.any { isActiveWorkState(it.runtimeState) }

internal fun isActiveWorkState(state: String?): Boolean =
    state in setOf("active", "running", "starting", "needs_you", "waiting-input", "awaiting-input")

internal fun findRosterProjectForSession(
    roster: RosterSnapshot?,
    sessionId: String,
): RosterProject? = roster?.projects?.firstOrNull { project ->
    project.chats.any { it.id == sessionId }
}

// ---------------------------------------------------------------------------
// Wire payload readers. Kept top-level so the parser tests can exercise them
// against realistic `work.listSessions` / `lanes.refreshSnapshots` fixtures.
// ---------------------------------------------------------------------------

/**
 * Null-safe primitive read. Using `.jsonPrimitive` directly throws when the key
 * holds an object or array — which `lane.status` and `lane.linearIssue` both do.
 */
private fun JsonObject.primitive(key: String): JsonPrimitive? = get(key) as? JsonPrimitive

internal fun JsonObject.string(key: String): String? =
    primitive(key)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

internal fun JsonObject.int(key: String): Int? = primitive(key)?.intOrNull

/** Accepts real JSON booleans and the `"true"`/`"false"` strings older hosts send. */
internal fun JsonObject.bool(key: String): Boolean? =
    when (primitive(key)?.contentOrNull?.lowercase()) {
        "true" -> true
        "false" -> false
        else -> null
    }

/** True when the key carries a non-null value — the `archivedAt`/`settledAt` idiom. */
internal fun JsonObject.present(key: String): Boolean {
    val value = get(key) ?: return false
    return value !is JsonNull
}

internal fun parseLanes(result: JsonElement): List<UiLane> {
    val objectValue = result as? JsonObject
    val snapshots = objectValue?.get("snapshots") as? JsonArray
    val raw = snapshots ?: objectValue?.get("lanes") as? JsonArray ?: result as? JsonArray ?: JsonArray(emptyList())
    return raw.mapNotNull { item ->
        val source = item as? JsonObject ?: return@mapNotNull null
        val lane = source["lane"] as? JsonObject ?: source
        val id = lane.string("id") ?: source.string("laneId") ?: return@mapNotNull null
        val runtime = source["runtime"] as? JsonObject
        val status = lane["status"] as? JsonObject
        UiLane(
            id = id,
            name = lane.string("name") ?: lane.string("displayName") ?: "Lane",
            branch = lane.string("branchRef") ?: lane.string("branch"),
            state = runtime?.string("bucket") ?: lane.string("status"),
            running = runtime?.int("runningCount") ?: 0,
            awaiting = runtime?.int("awaitingInputCount") ?: 0,
            archived = lane.present("archivedAt"),
            laneType = lane.string("laneType"),
            description = lane.string("description"),
            color = lane.string("color"),
            dirty = status?.bool("dirty") == true,
            ahead = status?.int("ahead") ?: 0,
            behind = status?.int("behind") ?: 0,
            remoteBehind = status?.int("remoteBehind") ?: 0,
            rebaseInProgress = status?.bool("rebaseInProgress") == true,
            hasStatus = status != null,
            childCount = lane.int("childCount") ?: 0,
            stackDepth = lane.int("stackDepth") ?: 0,
            parentLaneId = lane.string("parentLaneId"),
            linearIdentifier = (lane["linearIssue"] as? JsonObject)?.string("identifier"),
            devicesOpen = (lane["devicesOpen"] as? JsonArray)?.size ?: 0,
        )
    }
}

internal fun parseSessions(result: JsonElement): List<UiSession> = (result as? JsonArray).orEmpty().mapNotNull { item ->
    val source = item as? JsonObject ?: return@mapNotNull null
    val id = source.string("id") ?: source.string("sessionId") ?: return@mapNotNull null
    val wireProvider = source.string("provider")
    val toolType = source.string("toolType")
    // `work.listSessions` returns `TerminalSessionSummary`, which has no
    // top-level `provider` column at all -- so `wireProvider` is null for every
    // real row and the provider theming (logo + tint) would never engage. Derive
    // it from `toolType` the way iOS and the host itself do. `kind` deliberately
    // keeps reading the RAW wire provider: deriving into it would reclassify
    // every tracked CLI session as a chat.
    val provider = wireProvider ?: com.ade.android.ui.providerFromToolType(toolType)
    UiSession(
        id = id,
        laneId = source.string("laneId"),
        laneName = source.string("laneName"),
        title = source.string("title") ?: source.string("goal") ?: "Untitled session",
        provider = provider,
        toolType = toolType,
        runtimeState = source.string("runtimeState") ?: source.string("status"),
        preview = source.string("lastOutputPreview") ?: source.string("preview"),
        pendingInputItemId = source.string("pendingInputItemId"),
        kind = if (toolType?.contains("chat", true) == true || wireProvider != null) SessionKind.CHAT else SessionKind.TERMINAL,
        archived = source.present("archivedAt"),
        status = source.string("status"),
        startedAt = source.string("startedAt"),
        lastActivityAt = source.string("lastActivityAt"),
        settledAt = source.string("settledAt"),
        statusNote = source.string("statusNote"),
        attentionRequestedAt = source.string("attentionRequestedAt"),
        attentionMessage = source.string("attentionMessage"),
        lastTurnFailedAt = source.string("lastTurnFailedAt"),
        exitCode = source.int("exitCode"),
        pinned = source.bool("pinned") == true,
        summary = source.string("summary"),
        goal = source.string("goal"),
        currentTurnStartedAt = source.string("currentTurnStartedAt"),
    )
}
