package com.ade.android.ui

import android.net.Uri
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ade.android.MainUiState
import com.ade.android.MainViewModel
import com.ade.android.HubComposerPreferences
import com.ade.android.SessionKind
import com.ade.android.UiLane
import com.ade.android.UiModel
import com.ade.android.UiSession
import com.ade.android.UiGitHubRepo
import com.ade.android.UiProjectBrowseEntry
import com.ade.sync.model.MobileProject
import com.ade.sync.model.RosterProject
import com.ade.sync.model.RosterChat
import com.ade.sync.model.RosterLane
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubScreen(
    viewModel: MainViewModel,
    onSettings: () -> Unit,
    onPair: () -> Unit,
    onOpenProject: (MobileProject) -> Unit,
    onOpenSession: (UiSession) -> Unit,
    onPersonalChats: () -> Unit,
) {
    val status by viewModel.syncStatus.collectAsStateWithLifecycle()
    val roster by viewModel.roster.collectAsStateWithLifecycle()
    val catalog by viewModel.catalog.collectAsStateWithLifecycle()
    val state by viewModel.ui.collectAsStateWithLifecycle()
    var composerOpen by remember { mutableStateOf(false) }
    var attentionOpen by remember { mutableStateOf(false) }
    var addProjectOpen by remember { mutableStateOf(false) }
    val orderedProjects = catalog.projects.sortedWith(compareBy { project ->
        state.hubProjectOrder.indexOf(project.id).takeIf { it >= 0 } ?: Int.MAX_VALUE
    })
    LaunchedEffect(attentionOpen) { viewModel.setAttentionDrawerVisible(attentionOpen) }
    DisposableEffect(Unit) { onDispose { viewModel.setAttentionDrawerVisible(false) } }

    Scaffold(
        topBar = {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("ADE", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                Surface(
                    Modifier.padding(start = 12.dp),
                    shape = CircleShape,
                    color = if (status.state == "connected") MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Row(
                        Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Surface(
                            Modifier.size(7.dp),
                            shape = CircleShape,
                            color = if (status.state == "connected") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                        ) {}
                        Text(
                            state.openingProjectName?.let { "Opening $it…" }
                                ?: status.hostName
                                ?: if (status.state == "connecting") "Connecting…" else "No machine",
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { addProjectOpen = true; viewModel.loadProjectAddSheet() }) {
                    Icon(Icons.Rounded.FolderOpen, "Add project")
                }
                Box {
                    IconButton(onClick = onPersonalChats) { Icon(Icons.Rounded.ChatBubbleOutline, "Personal chats") }
                    val awaiting = state.personalChats.count {
                        it.pendingInputItemId != null || it.runtimeState == "awaiting-input"
                    }
                    if (awaiting > 0) Surface(
                        Modifier.align(Alignment.TopEnd),
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.error,
                    ) {
                        Text(
                            awaiting.coerceAtMost(99).toString(),
                            Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onError,
                        )
                    }
                }
                Box {
                    IconButton(onClick = { attentionOpen = true }) { Icon(Icons.Rounded.Notifications, "Attention") }
                    if (state.attentionItems.isNotEmpty()) Surface(
                        Modifier.align(Alignment.TopEnd),
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.error,
                    ) {
                        Text(
                            state.attentionItems.size.coerceAtMost(99).toString(),
                            Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onError,
                        )
                    }
                }
                IconButton(onClick = onSettings) { Icon(Icons.Rounded.Settings, "Settings") }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { composerOpen = true },
                icon = { Icon(Icons.Rounded.Add, null) },
                text = { Text("Start work") },
            )
        },
    ) { padding ->
        if (status.state != "connected" && roster == null) {
            NoMachineHub(state, onPair, viewModel)
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).padding(horizontal = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SectionTitle("Projects", "Live work across this machine")
                        Spacer(Modifier.weight(1f))
                        IconButton(onClick = viewModel::refreshAll) { Icon(Icons.Rounded.Refresh, "Refresh") }
                    }
                }
                items(orderedProjects, key = MobileProject::id) { project ->
                    val rosterProject = roster?.projects?.firstOrNull { it.projectId == project.id }
                    Box(Modifier.pointerInput(project.id, orderedProjects.map(MobileProject::id)) {
                        var dragged = 0f
                        detectDragGesturesAfterLongPress(
                            onDragEnd = { dragged = 0f },
                            onDragCancel = { dragged = 0f },
                        ) { change, amount ->
                            change.consume()
                            dragged += amount.y
                            if (kotlin.math.abs(dragged) >= 56f) {
                                val ids = orderedProjects.map(MobileProject::id).toMutableList()
                                val from = ids.indexOf(project.id)
                                val to = (from + if (dragged > 0) 1 else -1).coerceIn(ids.indices)
                                if (from >= 0 && from != to) {
                                    java.util.Collections.swap(ids, from, to)
                                    viewModel.setHubProjectOrder(ids)
                                }
                                dragged = 0f
                            }
                        }
                    }) {
                        ProjectCard(
                            project,
                            rosterProject,
                            collapsed = project.id in state.hubCollapsedProjectIds,
                            onToggle = { viewModel.setHubCollapsed(project.id, project.id !in state.hubCollapsedProjectIds) },
                            onOpen = { viewModel.openProject(project) { onOpenProject(project) } },
                            onOpenSession = { chatId -> viewModel.openRosterSession(project, chatId, onOpenSession) },
                            onArchiveSession = { chatId -> viewModel.runRosterSessionAction("chat.archive", project, chatId) },
                            onCloseSession = { chatId -> viewModel.runRosterSessionAction("chat.delete", project, chatId) },
                            canArchive = viewModel.canInvoke("chat.archive"),
                            canClose = viewModel.canInvoke("chat.delete"),
                            collapsedLaneKeys = state.hubCollapsedLaneKeys,
                            onToggleLane = { laneId, collapsed -> viewModel.setHubLaneCollapsed(project.id, laneId, collapsed) },
                        )
                    }
                }
                if (catalog.projects.isEmpty()) item {
                    AdeCard {
                        Text("No projects yet", fontWeight = FontWeight.SemiBold)
                        Text("Open or clone a project from ADE on the machine, then refresh.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                item { Spacer(Modifier.height(88.dp)) }
            }
        }
    }
    if (composerOpen) HubComposer(
        projects = catalog.projects,
        roster = roster?.projects.orEmpty(),
        models = state.models,
        attachmentsEnabled = viewModel.canInvoke("chat.saveTempAttachment"),
        canCreateLane = viewModel.canInvoke("lanes.create"),
        canStartChat = viewModel.canInvoke("chat.create") && viewModel.canInvoke("chat.send"),
        canStartCli = viewModel.canInvoke("work.startCliSession"),
        initialDraft = state.hubComposerDraft,
        initialPreferences = state.hubComposerPreferences,
        onDraftChange = viewModel::setHubComposerDraft,
        onPreferencesChange = viewModel::setHubComposerPreferences,
        onDismiss = { composerOpen = false },
        onSend = { project, laneId, text, cli, model, mode, reasoning, attachment ->
            viewModel.createFromHub(project, laneId, text, cli, model, mode, reasoning, attachment)
            composerOpen = false
        },
    )
    if (attentionOpen) AttentionDrawer(state.attentionItems, viewModel) { attentionOpen = false }
    if (addProjectOpen) AddProjectSheet(
        state = state,
        viewModel = viewModel,
        onDismiss = { addProjectOpen = false },
        onProject = { project ->
            addProjectOpen = false
            viewModel.openProject(project) { onOpenProject(project) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttentionDrawer(items: List<JsonObject>, viewModel: MainViewModel, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Attention", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = viewModel::refreshAttention) { Icon(Icons.Rounded.Refresh, "Refresh") }
                }
            }
            items(items, key = { it.string("id") ?: it.hashCode().toString() }) { item ->
                AdeCard(Modifier.clickable { item.string("id")?.let(viewModel::markAttentionSeen) }) {
                    Text(item.string("title") ?: "ADE update", fontWeight = FontWeight.SemiBold)
                    item.string("preview")?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { item.string("id")?.let(viewModel::dismissAttention) }) { Text("Dismiss") }
                    }
                }
            }
            if (items.isEmpty()) item { Text("Nothing needs your attention.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item { Spacer(Modifier.height(20.dp)) }
        }
    }
}

@Composable
private fun NoMachineHub(state: MainUiState, onPair: () -> Unit, viewModel: MainViewModel) {
    Column(Modifier.fillMaxSize().padding(22.dp), verticalArrangement = Arrangement.Center) {
        Text("Connect a machine", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Pick a saved machine or pair nearby to see every project and active chat.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))
        val online = state.machines.filter { directory ->
            directory.online && (directory.reachableEndpoints.isNotEmpty() || state.savedMachines.any { it.matches(directory) })
        }.take(2)
        online.forEach { machine ->
            val saved = state.savedMachines.firstOrNull { it.matches(machine) }
            AdeCard(Modifier.padding(bottom = 10.dp).clickable {
                if (saved != null) viewModel.connect(saved) else viewModel.connectAccount(machine) {}
            }) {
                Text(machine.customName ?: machine.name ?: "ADE machine", fontWeight = FontWeight.SemiBold)
                Text("Online · tap to connect", style = MaterialTheme.typography.bodySmall)
            }
        }
        state.savedMachines.filter { saved -> online.none(saved::matches) }
            .take((2 - online.size).coerceAtLeast(0)).forEach { machine ->
            AdeCard(Modifier.padding(bottom = 10.dp).clickable { viewModel.connect(machine) }) {
                Text(machine.name, fontWeight = FontWeight.SemiBold)
                Text("Saved pairing · tap to connect", style = MaterialTheme.typography.bodySmall)
            }
        }
        Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Add a machine") }
    }
}

@Composable
private fun ProjectCard(
    project: MobileProject,
    roster: RosterProject?,
    collapsed: Boolean,
    onToggle: () -> Unit,
    onOpen: () -> Unit,
    onOpenSession: (String) -> Unit,
    onArchiveSession: (String) -> Unit,
    onCloseSession: (String) -> Unit,
    canArchive: Boolean,
    canClose: Boolean,
    collapsedLaneKeys: Set<String>,
    onToggleLane: (String, Boolean) -> Unit,
) {
    AdeCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Surface(Modifier.size(40.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                ProjectIcon(project.iconDataUrl ?: roster?.iconDataUrl, project.displayName)
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp).clickable(onClick = onOpen)) {
                Text(project.displayName, fontWeight = FontWeight.SemiBold)
                Text(
                    "${roster?.lanes?.size ?: project.laneCount} lanes · ${roster?.chats?.size ?: 0} chats",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onToggle) { Icon(if (collapsed) Icons.Rounded.ExpandMore else Icons.Rounded.ExpandLess, "Toggle project") }
        }
        if (!collapsed && roster != null) {
            val knownLaneIds = roster.lanes.mapTo(mutableSetOf(), RosterLane::id)
            roster.lanes.forEach { lane ->
                val laneKey = "${project.id}:${lane.id}"
                val laneCollapsed = laneKey in collapsedLaneKeys
                Row(
                    Modifier.fillMaxWidth().clickable { onToggleLane(lane.id, !laneCollapsed) }.padding(top = 10.dp, bottom = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(lane.name, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                    Icon(if (laneCollapsed) Icons.Rounded.ExpandMore else Icons.Rounded.ExpandLess, "Toggle lane", Modifier.size(18.dp))
                }
                if (!laneCollapsed) {
                    roster.chats.filter { it.laneId == lane.id && it.chatSessionId == null && !it.archived }.forEach { chat ->
                        RosterChatRow(chat, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = false)
                        roster.chats.filter { it.chatSessionId == chat.id }.forEach { shell ->
                            RosterChatRow(shell, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = true)
                        }
                    }
                }
            }
            val ungrouped = roster.chats.filter {
                it.chatSessionId == null && !it.archived && it.laneId !in knownLaneIds
            }
            if (ungrouped.isNotEmpty()) {
                Text("Other", Modifier.padding(top = 10.dp, bottom = 3.dp), style = MaterialTheme.typography.labelLarge)
                ungrouped.forEach { chat ->
                    RosterChatRow(chat, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = false)
                    roster.chats.filter { it.chatSessionId == chat.id }.forEach { shell ->
                        RosterChatRow(shell, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = true)
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onOpen) { Text("Open project") }
            }
        }
    }
}

@Composable
private fun ProjectIcon(dataUrl: String?, name: String) {
    val image = remember(dataUrl) {
        runCatching {
            val encoded = dataUrl?.takeIf { it.startsWith("data:image/") }?.substringAfter(";base64,")
                ?.takeIf(String::isNotBlank) ?: return@runCatching null
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    if (image != null) {
        Image(image, name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    } else {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(name.take(1).uppercase(), fontWeight = FontWeight.Bold)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RosterChatRow(
    chat: RosterChat,
    onOpenSession: (String) -> Unit,
    onArchiveSession: (String) -> Unit,
    onCloseSession: (String) -> Unit,
    canArchive: Boolean,
    canClose: Boolean,
    nested: Boolean,
) {
    var menuOpen by remember(chat.id) { mutableStateOf(false) }
    val isChat = chat.provider != null || chat.toolType?.contains("chat", ignoreCase = true) == true
    Row(
        Modifier.fillMaxWidth()
            .padding(start = if (nested) 28.dp else 0.dp)
            .combinedClickable(
                onClick = { onOpenSession(chat.id) },
                onLongClick = { menuOpen = true },
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProviderMark(chat.provider, isChat)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(chat.title ?: if (nested) "Attached shell" else "Untitled", maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(chat.provider?.replaceFirstChar(Char::uppercase), relativeActivity(chat.lastActivityAt)).joinToString(" · ")
                    .ifBlank { chat.status },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (chat.awaitingInput) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
            Text("!", Modifier.padding(horizontal = 7.dp, vertical = 2.dp), color = MaterialTheme.colorScheme.onPrimary)
        }
        Box {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(if (isChat) "Open chat" else "Open session") },
                    onClick = { menuOpen = false; onOpenSession(chat.id) },
                )
                if (isChat) {
                    DropdownMenuItem(
                        text = { Text("Archive") },
                        enabled = canArchive,
                        onClick = { menuOpen = false; onArchiveSession(chat.id) },
                    )
                    DropdownMenuItem(
                        text = { Text("Close chat", color = MaterialTheme.colorScheme.error) },
                        enabled = canClose,
                        onClick = { menuOpen = false; onCloseSession(chat.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ProviderMark(provider: String?, isChat: Boolean) {
    Surface(Modifier.size(22.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant) {
        Box(contentAlignment = Alignment.Center) {
            if (provider.isNullOrBlank()) {
                Icon(if (isChat) Icons.Rounded.ChatBubbleOutline else Icons.Rounded.Code, null, Modifier.size(15.dp))
            } else {
                Text(provider.take(1).uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
        }
    }
}

private fun relativeActivity(value: String?): String? {
    val instant = runCatching { value?.let(Instant::parse) }.getOrNull() ?: return null
    val seconds = Duration.between(instant, Instant.now()).seconds.coerceAtLeast(0)
    return when {
        seconds < 60 -> "now"
        seconds < 3_600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3_600}h"
        seconds < 604_800 -> "${seconds / 86_400}d"
        else -> "${seconds / 604_800}w"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HubComposer(
    projects: List<MobileProject>,
    roster: List<RosterProject>,
    models: List<UiModel>,
    attachmentsEnabled: Boolean,
    canCreateLane: Boolean,
    canStartChat: Boolean,
    canStartCli: Boolean,
    initialDraft: String,
    initialPreferences: HubComposerPreferences,
    onDraftChange: (String) -> Unit,
    onPreferencesChange: (HubComposerPreferences) -> Unit,
    onDismiss: () -> Unit,
    onSend: (MobileProject, String?, String, Boolean, UiModel?, String, String?, Uri?) -> Unit,
) {
    var project by remember(projects, initialPreferences.projectId) {
        mutableStateOf(projects.firstOrNull { it.id == initialPreferences.projectId } ?: projects.firstOrNull())
    }
    var laneId by remember(initialPreferences.laneId) { mutableStateOf(initialPreferences.laneId) }
    var text by remember(initialDraft) { mutableStateOf(initialDraft) }
    var cli by remember(initialPreferences.cli) { mutableStateOf(initialPreferences.cli) }
    var model by remember(models, initialPreferences.modelId) {
        mutableStateOf(models.firstOrNull { it.id == initialPreferences.modelId } ?: models.firstOrNull { it.provider == "codex" } ?: models.firstOrNull())
    }
    var permissionMode by remember(initialPreferences.permissionMode) { mutableStateOf(initialPreferences.permissionMode) }
    var reasoning by remember(model?.id, initialPreferences.reasoning) { mutableStateOf(initialPreferences.reasoning ?: model?.defaultReasoning) }
    var attachment by remember { mutableStateOf<Uri?>(null) }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> attachment = uri }
    var projectMenu by remember { mutableStateOf(false) }
    var laneMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }
    var modeMenu by remember { mutableStateOf(false) }
    var reasoningMenu by remember { mutableStateOf(false) }
    fun persistPreferences() = onPreferencesChange(HubComposerPreferences(
        projectId = project?.id,
        laneId = laneId,
        cli = cli,
        modelId = model?.id,
        permissionMode = permissionMode,
        reasoning = reasoning,
    ))
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Start work", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box {
                    OutlinedButton(onClick = { projectMenu = true }) { Text(project?.displayName ?: "Project") }
                    DropdownMenu(projectMenu, { projectMenu = false }) {
                        projects.forEach { item -> DropdownMenuItem({ Text(item.displayName) }, onClick = {
                            project = item; laneId = null; projectMenu = false; persistPreferences()
                        }) }
                    }
                }
                Box {
                    OutlinedButton(onClick = { laneMenu = true }, enabled = project != null) { Text(laneId?.let { id -> roster.firstOrNull { it.projectId == project?.id }?.lanes?.firstOrNull { it.id == id }?.name } ?: "New lane") }
                    DropdownMenu(laneMenu, { laneMenu = false }) {
                        DropdownMenuItem({ Text("New lane") }, onClick = { laneId = null; laneMenu = false; persistPreferences() })
                        roster.firstOrNull { it.projectId == project?.id }?.lanes.orEmpty().forEach { lane ->
                            DropdownMenuItem({ Text(lane.name) }, onClick = { laneId = lane.id; laneMenu = false; persistPreferences() })
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Chat", fontWeight = if (!cli) FontWeight.Bold else FontWeight.Normal)
                Switch(cli, { cli = it; persistPreferences() }, Modifier.padding(horizontal = 10.dp))
                Text("CLI", fontWeight = if (cli) FontWeight.Bold else FontWeight.Normal)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.weight(1f)) {
                    OutlinedButton({ modelMenu = true }, Modifier.fillMaxWidth()) {
                        Text(model?.name ?: "Default model", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(modelMenu, { modelMenu = false }) {
                        models.forEach { item ->
                            DropdownMenuItem(
                                { Text("${item.name} · ${item.provider}") },
                                onClick = { model = item; reasoning = item.defaultReasoning; modelMenu = false; persistPreferences() },
                            )
                        }
                    }
                }
                Box(Modifier.weight(1f)) {
                    OutlinedButton({ modeMenu = true }, Modifier.fillMaxWidth()) { Text(permissionMode.replace('-', ' ')) }
                    DropdownMenu(modeMenu, { modeMenu = false }) {
                        listOf("default", "plan", "edit", "full-auto").forEach { item ->
                            DropdownMenuItem({ Text(item.replace('-', ' ')) }, onClick = { permissionMode = item; modeMenu = false; persistPreferences() })
                        }
                    }
                }
                Box(Modifier.weight(1f)) {
                    OutlinedButton({ reasoningMenu = true }, Modifier.fillMaxWidth(), enabled = model?.reasoningEfforts?.isNotEmpty() == true) {
                        Text(reasoning ?: "Reasoning", maxLines = 1)
                    }
                    DropdownMenu(reasoningMenu, { reasoningMenu = false }) {
                        model?.reasoningEfforts.orEmpty().forEach { item ->
                            DropdownMenuItem({ Text(item) }, onClick = { reasoning = item; reasoningMenu = false; persistPreferences() })
                        }
                    }
                }
            }
            OutlinedTextField(text, { text = it; onDraftChange(it) }, Modifier.fillMaxWidth(), minLines = 3, label = { Text("What should the agent do?") })
            attachment?.let { uri ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(uri.lastPathSegment ?: "Image attachment", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton({ attachment = null }) { Text("Remove") }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { attachmentPicker.launch("image/*") }, enabled = !cli && attachmentsEnabled) { Text("Attach image") }
                Button(
                    onClick = { project?.let { onSend(it, laneId, text.trim(), cli, model, permissionMode, reasoning, attachment) } },
                    enabled = project != null && (laneId != null || canCreateLane) &&
                        (if (cli) canStartCli else canStartChat) &&
                        (text.isNotBlank() || (!cli && attachment != null)),
                    modifier = Modifier.weight(1f),
                ) { Text("Send") }
            }
            Spacer(Modifier.height(22.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddProjectSheet(
    state: MainUiState,
    viewModel: MainViewModel,
    onDismiss: () -> Unit,
    onProject: (MobileProject) -> Unit,
) {
    var mode by remember { mutableStateOf("open") }
    var openPath by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var parent by remember { mutableStateOf("") }
    var cloneUrl by remember { mutableStateOf("") }
    var repoSearch by remember { mutableStateOf("") }
    LaunchedEffect(state.projectDefaultParent) {
        if (parent.isBlank()) parent = state.projectDefaultParent
        if (openPath.isBlank()) openPath = state.projectDefaultParent
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Text("Add project", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("open" to "Open", "create" to "Create", "clone" to "Clone").forEach { (id, label) ->
                        if (mode == id) Button({ mode = id }, Modifier.weight(1f)) { Text(label) }
                        else OutlinedButton({ mode = id }, Modifier.weight(1f)) { Text(label) }
                    }
                }
            }
            when (mode) {
                "open" -> {
                    item {
                        OutlinedTextField(openPath, { openPath = it }, Modifier.fillMaxWidth(), label = { Text("Folder on machine") })
                    }
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton({ viewModel.browseProjectDirectories(openPath) }) { Text("Browse") }
                            Button(
                                { viewModel.openMachineProject(openPath, onProject) },
                                enabled = openPath.isNotBlank(),
                                modifier = Modifier.weight(1f),
                            ) { Text("Open project") }
                        }
                    }
                    items(state.projectBrowseEntries.take(12), key = UiProjectBrowseEntry::fullPath) { entry ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                openPath = entry.fullPath
                                if (!entry.gitRepository) viewModel.browseProjectDirectories(entry.fullPath)
                            }.padding(vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(entry.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (entry.gitRepository) "Git project" else "Folder", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                "create" -> {
                    item { OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Project name") }) }
                    item { OutlinedTextField(parent, { parent = it }, Modifier.fillMaxWidth(), label = { Text("Parent folder") }) }
                    item {
                        Button(
                            { viewModel.createMachineProject(name, parent, onProject) },
                            enabled = name.isNotBlank() && parent.isNotBlank(),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Create project") }
                    }
                }
                else -> {
                    item {
                        OutlinedTextField(repoSearch, {
                            repoSearch = it
                            viewModel.listGitHubRepos(it)
                        }, Modifier.fillMaxWidth(), label = { Text("Search GitHub") })
                    }
                    items(state.githubRepos.take(8), key = UiGitHubRepo::fullName) { repo ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                cloneUrl = repo.cloneUrl
                                if (name.isBlank()) name = repo.fullName.substringAfter('/')
                            }.padding(vertical = 7.dp),
                        ) {
                            Text(repo.fullName, Modifier.weight(1f))
                            if (repo.private) Text("Private", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    item { OutlinedTextField(cloneUrl, { cloneUrl = it }, Modifier.fillMaxWidth(), label = { Text("Repository URL") }) }
                    item { OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Folder name (optional)") }) }
                    item { OutlinedTextField(parent, { parent = it }, Modifier.fillMaxWidth(), label = { Text("Parent folder") }) }
                    item {
                        Button(
                            { viewModel.cloneMachineProject(cloneUrl, name, parent, onProject) },
                            enabled = cloneUrl.isNotBlank() && parent.isNotBlank(),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Clone project") }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun PersonalChatsScreen(
    viewModel: MainViewModel,
    onBack: () -> Unit,
    onSession: (UiSession) -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    var search by remember { mutableStateOf("") }
    var showArchived by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    val needle = search.trim().lowercase()
    val visible = state.personalChats.filter { session ->
        (showArchived || !session.archived) && (needle.isEmpty() || listOfNotNull(
            session.title,
            session.preview,
            session.provider,
            session.model,
        ).any { needle in it.lowercase() })
    }
    LaunchedEffect(Unit) {
        while (true) {
            viewModel.refreshPersonalChats()
            delay(5_000)
        }
    }

    AdeScreen("Personal chats", onBack, actions = {
        IconButton(onClick = viewModel::refreshPersonalChats) { Icon(Icons.Rounded.Refresh, "Refresh chats") }
        IconButton(
            onClick = { creating = true },
            enabled = viewModel.canInvoke("personalChats.create"),
        ) { Icon(Icons.Rounded.Add, "New personal chat") }
    }) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Search chats") },
                    singleLine = true,
                )
            }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Show archived", Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Switch(showArchived, { showArchived = it })
                }
            }
            items(visible, key = UiSession::id) { session ->
                AdeCard(
                    Modifier.combinedClickable(
                        onClick = { onSession(session) },
                        onLongClick = {
                            viewModel.runPersonalChatAction(if (session.archived) "unarchive" else "archive", session.id)
                        },
                    ),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ProviderMark(session.provider, true)
                        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            Text(session.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                session.preview ?: listOfNotNull(session.provider, session.model).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (session.pendingInputItemId != null || session.runtimeState == "awaiting-input") {
                            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.error) {
                                Text("!", Modifier.padding(horizontal = 7.dp, vertical = 2.dp), color = MaterialTheme.colorScheme.onError)
                            }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(
                            onClick = { viewModel.runPersonalChatAction(if (session.archived) "unarchive" else "archive", session.id) },
                            enabled = viewModel.canInvoke("personalChats.${if (session.archived) "unarchive" else "archive"}"),
                        ) { Text(if (session.archived) "Restore" else "Archive") }
                        TextButton(
                            onClick = { viewModel.runPersonalChatAction("delete", session.id) },
                            enabled = viewModel.canInvoke("personalChats.delete"),
                        ) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
            if (visible.isEmpty()) item {
                AdeCard {
                    Text(if (needle.isEmpty()) "Start a projectless chat" else "No matching chats", fontWeight = FontWeight.SemiBold)
                    Text(
                        if (needle.isEmpty()) "Ask something without choosing a project or lane." else "Try another title, provider, or phrase.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (needle.isEmpty()) Button(
                        onClick = { creating = true },
                        enabled = viewModel.canInvoke("personalChats.create"),
                    ) { Text("Start a chat") }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    if (creating) PersonalChatComposer(
        models = state.models,
        onDismiss = { creating = false },
        onCreate = { prompt, model, permissionMode, reasoning ->
            viewModel.createPersonalChat(prompt, model, permissionMode, reasoning) { session ->
                creating = false
                onSession(session)
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PersonalChatComposer(
    models: List<UiModel>,
    onDismiss: () -> Unit,
    onCreate: (String, UiModel?, String, String?) -> Unit,
) {
    var prompt by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf<String?>(null) }
    var modelMenu by remember { mutableStateOf(false) }
    var permissionMode by remember { mutableStateOf("default") }
    var modeMenu by remember { mutableStateOf(false) }
    var reasoning by remember { mutableStateOf<String?>(null) }
    var reasoningMenu by remember { mutableStateOf(false) }
    LaunchedEffect(models) {
        if (modelId == null) modelId = models.firstOrNull()?.id
    }
    val model = models.firstOrNull { it.id == modelId }
    LaunchedEffect(model?.id) {
        reasoning = model?.defaultReasoning?.takeIf { it in model.reasoningEfforts }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("New personal chat", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Box(Modifier.fillMaxWidth()) {
                OutlinedButton({ modelMenu = true }, Modifier.fillMaxWidth()) { Text(model?.name ?: "Default model") }
                DropdownMenu(modelMenu, { modelMenu = false }) {
                    models.forEach { item ->
                        DropdownMenuItem({ Text("${item.name} · ${item.provider}") }, onClick = {
                            modelId = item.id
                            modelMenu = false
                        })
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) {
                    OutlinedButton({ modeMenu = true }, Modifier.fillMaxWidth()) { Text(permissionMode.replace('-', ' ')) }
                    DropdownMenu(modeMenu, { modeMenu = false }) {
                        listOf("default", "plan", "edit", "full-auto").forEach { item ->
                            DropdownMenuItem({ Text(item.replace('-', ' ')) }, onClick = {
                                permissionMode = item
                                modeMenu = false
                            })
                        }
                    }
                }
                Box(Modifier.weight(1f)) {
                    OutlinedButton(
                        onClick = { reasoningMenu = true },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = model?.reasoningEfforts?.isNotEmpty() == true,
                    ) { Text(reasoning ?: "Reasoning") }
                    DropdownMenu(reasoningMenu, { reasoningMenu = false }) {
                        model?.reasoningEfforts.orEmpty().forEach { item ->
                            DropdownMenuItem({ Text(item) }, onClick = {
                                reasoning = item
                                reasoningMenu = false
                            })
                        }
                    }
                }
            }
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("What do you want to talk about?") },
                minLines = 4,
                maxLines = 8,
            )
            Button(
                onClick = { onCreate(prompt.trim(), model, permissionMode, reasoning) },
                enabled = prompt.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Start chat") }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
fun WorkspaceScreen(viewModel: MainViewModel, project: MobileProject?, onBack: () -> Unit, onSettings: () -> Unit, onSession: (UiSession) -> Unit) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val roster by viewModel.roster.collectAsStateWithLifecycle()
    var tab by remember { mutableStateOf("work") }
    var composerOpen by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, top = 12.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("Hub") }
                Text(project?.displayName ?: "Project", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 1)
                IconButton(onClick = onSettings) { Icon(Icons.Rounded.Settings, "Settings") }
            }
        },
        bottomBar = {
            Surface(tonalElevation = 2.dp) {
                Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = { tab = "work" }) { Text("Work", fontWeight = if (tab == "work") FontWeight.Bold else FontWeight.Normal) }
                    TextButton(onClick = { tab = "lanes" }) { Text("Lanes", fontWeight = if (tab == "lanes") FontWeight.Bold else FontWeight.Normal) }
                }
            }
        },
        floatingActionButton = {
            if (tab == "work" && project != null) FloatingActionButton({ composerOpen = true }) {
                Icon(Icons.Rounded.Add, "Start chat or CLI session")
            }
        },
    ) { padding ->
        if (tab == "work") WorkList(state.sessions, viewModel, Modifier.padding(padding), onSession)
        else LaneList(state.lanes, viewModel, Modifier.padding(padding))
    }
    if (composerOpen && project != null) HubComposer(
        projects = listOf(project),
        roster = roster?.projects.orEmpty(),
        models = state.models,
        attachmentsEnabled = viewModel.canInvoke("chat.saveTempAttachment"),
        canCreateLane = viewModel.canInvoke("lanes.create"),
        canStartChat = viewModel.canInvoke("chat.create") && viewModel.canInvoke("chat.send"),
        canStartCli = viewModel.canInvoke("work.startCliSession"),
        initialDraft = state.hubComposerDraft,
        initialPreferences = state.hubComposerPreferences.copy(projectId = project.id),
        onDraftChange = viewModel::setHubComposerDraft,
        onPreferencesChange = viewModel::setHubComposerPreferences,
        onDismiss = { composerOpen = false },
        onSend = { target, laneId, text, cli, model, mode, reasoning, attachment ->
            viewModel.createFromHub(target, laneId, text, cli, model, mode, reasoning, attachment)
            composerOpen = false
        },
    )
}

@Composable
private fun WorkList(sessions: List<UiSession>, viewModel: MainViewModel, modifier: Modifier, onSession: (UiSession) -> Unit) {
    LazyColumn(modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        item { SectionTitle("Work", "Chats and tracked terminal sessions") }
        items(sessions, key = UiSession::id) { session ->
            AdeCard(Modifier.clickable { onSession(session) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (session.kind == SessionKind.CHAT) Icons.Rounded.ChatBubbleOutline else Icons.Rounded.Code, null)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(session.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${session.laneName ?: "Lane"} · ${session.runtimeState ?: "idle"}", style = MaterialTheme.typography.bodySmall)
                        session.preview?.let { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    Icon(Icons.Rounded.ChevronRight, null)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (session.runtimeState in setOf("running", "starting", "needs_you")) {
                        TextButton(
                            { viewModel.runSessionAction("work.stopRuntime", session.id) },
                            enabled = viewModel.canInvoke("work.stopRuntime"),
                        ) { Text("Stop") }
                    }
                    if (session.kind == SessionKind.CHAT) {
                        TextButton(
                            { viewModel.runSessionAction("chat.archive", session.id) },
                            enabled = viewModel.canInvoke("chat.archive"),
                        ) { Text("Archive") }
                    }
                }
            }
        }
    }
}

@Composable
private fun LaneList(lanes: List<UiLane>, viewModel: MainViewModel, modifier: Modifier) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    var expandedLane by remember { mutableStateOf<String?>(null) }
    var renamingLane by remember { mutableStateOf<UiLane?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deletingLane by remember { mutableStateOf<UiLane?>(null) }
    renamingLane?.let { lane ->
        AlertDialog(
            onDismissRequest = { renamingLane = null },
            title = { Text("Rename lane") },
            text = { OutlinedTextField(renameText, { renameText = it }, label = { Text("Name") }) },
            confirmButton = { TextButton({ viewModel.renameLane(lane.id, renameText); renamingLane = null }) { Text("Save") } },
            dismissButton = { TextButton({ renamingLane = null }) { Text("Cancel") } },
        )
    }
    deletingLane?.let { lane ->
        AlertDialog(
            onDismissRequest = { deletingLane = null },
            title = { Text("Delete ${lane.name}?") },
            text = { Text("This removes the lane worktree. This action cannot be undone from Android.") },
            confirmButton = { TextButton({ viewModel.runLaneAction("lanes.delete", lane.id); deletingLane = null }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton({ deletingLane = null }) { Text("Cancel") } },
        )
    }
    LazyColumn(modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        item { SectionTitle("Lanes", "Worktrees on this project") }
        items(lanes, key = UiLane::id) { lane ->
            val expanded = expandedLane == lane.id
            val detail = state.laneDetails[lane.id]
            AdeCard(Modifier.clickable {
                expandedLane = if (expanded) null else lane.id
                if (!expanded) viewModel.refreshLaneDetail(lane.id)
            }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(lane.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                    Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, "Lane details")
                }
                Text(lane.branch ?: "No branch", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${lane.state ?: "idle"} · ${lane.running} running · ${lane.awaiting} waiting", style = MaterialTheme.typography.bodySmall)
                if (expanded) {
                    if (detail == null) Text("Loading lane detail…", style = MaterialTheme.typography.bodySmall)
                    else {
                        val laneSource = detail["lane"] as? JsonObject
                        laneSource?.string("description")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        Text(
                            "${(detail["recentCommits"] as? JsonArray)?.size ?: 0} recent commits · " +
                                "${(detail["sessions"] as? JsonArray)?.size ?: 0} terminals · " +
                                "${(detail["chatSessions"] as? JsonArray)?.size ?: 0} chats",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        (detail["syncStatus"] as? JsonObject)?.let { sync ->
                            Text(
                                "Upstream: ${sync.string("state") ?: sync.string("status") ?: "unknown"}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(
                            onClick = { renameText = lane.name; renamingLane = lane },
                            enabled = viewModel.canInvoke("lanes.rename"),
                        ) { Text("Rename") }
                        TextButton(
                            onClick = { viewModel.runLaneAction("git.sync", lane.id) },
                            enabled = viewModel.canInvoke("git.sync"),
                        ) { Text("Sync") }
                        if (lane.archived) {
                            TextButton(
                                onClick = { viewModel.runLaneAction("lanes.unarchive", lane.id) },
                                enabled = viewModel.canInvoke("lanes.unarchive"),
                            ) { Text("Restore") }
                        } else if (lane.laneType != "primary") {
                            TextButton(
                                onClick = { viewModel.runLaneAction("lanes.archive", lane.id) },
                                enabled = viewModel.canInvoke("lanes.archive"),
                            ) { Text("Archive") }
                        }
                        TextButton(
                            onClick = { deletingLane = lane },
                            enabled = viewModel.canInvoke("lanes.delete"),
                        ) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
    }
}

private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
