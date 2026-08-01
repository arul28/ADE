package com.ade.android

import android.app.Application
import android.app.NotificationManager
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ade.android.connection.AdeConnectionService
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
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

data class UiLane(
    val id: String,
    val name: String,
    val branch: String? = null,
    val state: String? = null,
    val running: Int = 0,
    val awaiting: Int = 0,
    val archived: Boolean = false,
    val laneType: String? = null,
)

enum class SessionKind { CHAT, TERMINAL }

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
    val hubProjectOrder: List<String> = emptyList(),
    val hubComposerDraft: String = "",
    val hubComposerPreferences: HubComposerPreferences = HubComposerPreferences(),
    val projectDefaultParent: String = "",
    val projectBrowseEntries: List<UiProjectBrowseEntry> = emptyList(),
    val githubRepos: List<UiGitHubRepo> = emptyList(),
    val models: List<UiModel> = emptyList(),
    val deepLinkSequence: Long = 0,
    val deepLinkSessionId: String? = null,
    val deepLinkMachineKey: String? = null,
    val openingProjectName: String? = null,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val graph = (application as AdeApplication).graph
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
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
        loadCache(machine.machineKey)
        graph.pairing.adopt(machine)
        reconcileAnalyticsPreference()
        captureAppOpenedNow()
        _ui.update { it.copy(savedMachines = graph.machineStore.list()) }
        refreshAllNow()
        resumeSelectedStream()
        onSuccess()
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
        val data = page.string("data").orEmpty()
        val start = page["startOffset"]?.jsonPrimitive?.content?.toLongOrNull() ?: before
        val atStart = page["atStart"]?.jsonPrimitive?.content == "true" || start <= 0
        _ui.update { it.copy(
            terminalData = data + it.terminalData,
            terminalStartOffset = start,
            terminalAtStart = atStart,
        ) }
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

    fun approve(sessionId: String, itemId: String, accept: Boolean) = launchBusy {
        graph.sync.sendCommand(chatAction("approve", sessionId), buildJsonObject {
            put("sessionId", sessionId)
            put("itemId", itemId)
            put("decision", if (accept) "accept" else "decline")
        })
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
            refreshAllNow()
            resumeSelectedStream()
            onSuccess()
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
        val result = graph.sync.sendCommand("lanes.refreshSnapshots", buildJsonObject { put("includeStatus", true) })
        val lanes = parseLanes(result)
        _ui.update { it.copy(lanes = lanes) }
        cache("lanes", result)
    }

    fun refreshSessions() = launchQuiet {
        if (!graph.sync.hasSelectedProject()) return@launchQuiet
        if (!graph.sync.canInvokeRemoteAction("work.listSessions")) return@launchQuiet
        val result = graph.sync.sendCommand("work.listSessions")
        val sessions = parseSessions(result)
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
        launchQuiet {
            sendAttentionPresence()
            if (foreground && graph.sync.status.value.state == "connected") resumeSelectedStream()
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
        graph.sync.sendTerminalInput(id, text)
    }

    fun resizeTerminal(rows: Int, columns: Int) {
        val id = _ui.value.selectedSessionId ?: return
        graph.sync.resizeTerminal(id, columns, rows)
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
        val sessions = parseSessions(result)
        _ui.update { it.copy(sessions = sessions) }
        reconcileForegroundService(sessions + _ui.value.personalChats)
        cache("sessions", result)
    }

    private suspend fun refreshPersonalChatsNow() {
        if (!graph.sync.canInvokeRemoteAction("personalChats.list")) return
        val result = graph.sync.sendCommand("personalChats.list", buildJsonObject { put("includeArchived", true) })
        val personalChats = parsePersonalChats(result)
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
        _ui.update { it.copy(
            hubCollapsedProjectIds = collapsed,
            hubCollapsedLaneKeys = collapsedLanes,
            hubProjectOrder = order,
            hubComposerDraft = draft,
            hubComposerPreferences = composerPreferences,
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

    private fun parseLanes(result: JsonElement): List<UiLane> {
        val objectValue = result as? JsonObject
        val snapshots = objectValue?.get("snapshots") as? JsonArray
        val raw = snapshots ?: objectValue?.get("lanes") as? JsonArray ?: result as? JsonArray ?: JsonArray(emptyList())
        return raw.mapNotNull { item ->
            val source = item as? JsonObject ?: return@mapNotNull null
            val lane = source["lane"] as? JsonObject ?: source
            val id = lane.string("id") ?: source.string("laneId") ?: return@mapNotNull null
            val runtime = source["runtime"] as? JsonObject
            UiLane(
                id = id,
                name = lane.string("name") ?: lane.string("displayName") ?: "Lane",
                branch = lane.string("branchRef") ?: lane.string("branch"),
                state = runtime?.string("bucket") ?: lane.string("status"),
                running = runtime?.get("runningCount")?.jsonPrimitive?.intOrNull ?: 0,
                awaiting = runtime?.get("awaitingInputCount")?.jsonPrimitive?.intOrNull ?: 0,
                archived = lane["archivedAt"] != null && lane["archivedAt"] !is JsonNull,
                laneType = lane.string("laneType"),
            )
        }
    }

    private fun parseSessions(result: JsonElement): List<UiSession> = (result as? JsonArray).orEmpty().mapNotNull { item ->
        val source = item as? JsonObject ?: return@mapNotNull null
        val id = source.string("id") ?: source.string("sessionId") ?: return@mapNotNull null
        val provider = source.string("provider")
        val toolType = source.string("toolType")
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
            kind = if (toolType?.contains("chat", true) == true || provider != null) SessionKind.CHAT else SessionKind.TERMINAL,
        )
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
        val text = source.string(if (replace) "transcript" else "data").orEmpty()
        val deltaSnapshot = replace && source["delta"]?.jsonPrimitive?.content == "true"
        val start = source["startOffset"]?.jsonPrimitive?.content?.toLongOrNull()
        val end = source["endOffset"]?.jsonPrimitive?.content?.toLongOrNull()
            ?: source["offset"]?.jsonPrimitive?.content?.toLongOrNull()
        _ui.update { state -> state.copy(
            terminalData = if (replace && !deltaSnapshot) text else state.terminalData + text,
            terminalStartOffset = if (replace && !deltaSnapshot) start else state.terminalStartOffset,
            terminalEndOffset = end ?: state.terminalEndOffset,
            terminalAtStart = if (replace && !deltaSnapshot) (start ?: 0) <= 0 else state.terminalAtStart,
        ) }
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

    private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

    companion object {
        private const val MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
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
