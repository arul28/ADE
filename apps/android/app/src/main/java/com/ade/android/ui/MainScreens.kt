package com.ade.android.ui

import android.net.Uri
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.AltRoute
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Button
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ade.android.MainUiState
import com.ade.android.MainViewModel
import com.ade.android.HubComposerPreferences
import com.ade.android.SessionKind
import com.ade.android.UiLane
import com.ade.android.UiModel
import com.ade.android.UiSession
import com.ade.android.WorkViewState
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

    Box(Modifier.fillMaxSize()) {
        AdeAuroraBackground()
        Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                AdeWordmark(compact = true)
                Surface(
                    Modifier.padding(start = 12.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.66f),
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.72f)),
                ) {
                    Row(
                        Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Surface(
                            Modifier.size(7.dp),
                            shape = CircleShape,
                            color = if (status.state == "connected") AdeSuccess
                            else if (status.state == "connecting" || state.reconnecting) AdeWarning
                            else MaterialTheme.colorScheme.outline,
                        ) {}
                        Text(
                            state.openingProjectName?.let { "Opening $it…" }
                                ?: status.hostName
                                ?: when {
                                    status.state == "connecting" -> "Connecting…"
                                    // "No machine" while the app is actively
                                    // retrying reads as "nothing is paired".
                                    state.reconnecting -> "Reconnecting…"
                                    else -> "No machine"
                                },
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                GlassIconButton(onClick = { addProjectOpen = true; viewModel.loadProjectAddSheet() }, contentDescription = "Add project") {
                    Icon(Icons.Rounded.Add, "Add project", Modifier.size(19.dp), tint = MaterialTheme.colorScheme.primary)
                }
                Box {
                    GlassIconButton(onClick = onPersonalChats, contentDescription = "Personal chats") {
                        Icon(Icons.Rounded.ChatBubbleOutline, "Personal chats", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
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
                    GlassIconButton(onClick = { attentionOpen = true }, contentDescription = "Attention") {
                        Icon(Icons.Rounded.Notifications, "Attention", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
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
                GlassIconButton(onClick = onSettings, contentDescription = "Settings") {
                    Icon(Icons.Rounded.Settings, "Settings", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        bottomBar = {
            // SPEC §6.2 / iOS IMG_2445: the Hub ends in a collapsed composer
            // pill, not a FAB. Tapping it expands the full destination picker
            // (project · lane · Chat/CLI · model · mode · send) below.
            HubComposerPill(
                draft = state.hubComposerDraft,
                onClick = { composerOpen = true },
            )
        },
        ) { padding ->
        if (status.state != "connected" && roster == null) {
            NoMachineHub(state, onPair, viewModel)
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).padding(horizontal = 14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SectionTitle("Projects", "Live work across this machine", Modifier.weight(1f))
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
                // The composer pill is a Scaffold bottomBar, so its height is
                // already in `padding`; this is just breathing room.
                item { Spacer(Modifier.height(12.dp)) }
            }
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
    AdeCard(padding = 10.dp) {
        // One compact row: icon + name + counts + disclosure + chevron, matching
        // iOS (IMG_2445). The row itself opens the project; the caret toggles
        // the inline lane/chat list.
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(onClick = onOpen).padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onToggle, modifier = Modifier.size(28.dp)) {
                Icon(
                    if (collapsed) Icons.Rounded.ChevronRight else Icons.Rounded.ExpandMore,
                    if (collapsed) "Expand project" else "Collapse project",
                    Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ProjectAvatar(project, roster)
            Text(
                // Hard cap first (a 200-char worktree name would otherwise
                // starve the counts), then layout-accurate middle ellipsis.
                middleTruncate(project.displayName, 38),
                Modifier.weight(1f).padding(start = 10.dp, end = 8.dp),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            Text(
                laneChatSummary(roster?.lanes?.size ?: project.laneCount, roster?.chats?.size ?: 0),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
            Icon(
                Icons.Rounded.ChevronRight,
                null,
                Modifier.padding(start = 6.dp).size(18.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
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
                    StatusDot(laneDisplayColor(lane.color), 9.dp)
                    Text(lane.name, Modifier.weight(1f).padding(start = 8.dp), style = MaterialTheme.typography.labelLarge, color = laneDisplayColor(lane.color))
                    Icon(if (laneCollapsed) Icons.Rounded.ChevronRight else Icons.Rounded.ExpandMore, "Toggle lane", Modifier.size(18.dp))
                }
                if (!laneCollapsed) {
                    roster.chats.filter { it.laneId == lane.id && it.chatSessionId == null && !it.archived }.forEach { chat ->
                        RosterChatRow(chat, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = false, laneTint = laneDisplayColor(lane.color))
                        roster.chats.filter { it.chatSessionId == chat.id }.forEach { shell ->
                            RosterChatRow(shell, onOpenSession, onArchiveSession, onCloseSession, canArchive, canClose, nested = true, laneTint = laneDisplayColor(lane.color))
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
        }
    }
}

/** Collapsed Hub composer, iOS `Type to vibecode…` pill (IMG_2445). */
@Composable
private fun HubComposerPill(draft: String, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Row(
        Modifier.fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(colors.composer)
            .border(1.dp, colors.glassBorder, RoundedCornerShape(24.dp))
            .pressableCard(onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.AutoAwesome, null, Modifier.size(17.dp), tint = colors.accent)
        Text(
            draft.trim().ifBlank { "Type to vibecode…" },
            Modifier.weight(1f).padding(horizontal = 10.dp),
            color = if (draft.isBlank()) colors.textMuted else colors.textPrimary,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Surface(shape = CircleShape, color = colors.accent.copy(alpha = 0.14f)) {
            Icon(
                Icons.Rounded.ArrowUpward,
                "Start work",
                Modifier.padding(6.dp).size(16.dp),
                tint = colors.accent,
            )
        }
    }
}

/**
 * Project tile. The catalog (`MobileProject`) supplies `iconDataUrl` — a real
 * per-project icon — but only for projects the desktop has one for; every other
 * project previously fell back to the first letter of the name, which made
 * `ade-win-smoke-…` and `ADE` both render as an identical "A". The fallback now
 * uses a two-character monogram on a tint derived from the project id.
 */
@Composable
private fun ProjectAvatar(project: MobileProject, roster: RosterProject?) {
    val dataUrl = project.iconDataUrl ?: roster?.iconDataUrl
    val shape = RoundedCornerShape(9.dp)
    // Same light-mode contrast clamp as lane colours: a raw #FFD60A monogram on
    // its own 15%-alpha wash is unreadable on the light Hub.
    val tint = readableOnLightArgb(projectTintArgb(project.id), AdeTokens.colors.isDark).toComposeColor()
    Surface(
        Modifier.size(34.dp).border(1.dp, tint.copy(alpha = 0.32f), shape),
        shape = shape,
        color = tint.copy(alpha = 0.15f),
    ) {
        ProjectIcon(dataUrl, project.displayName, monogramTint = tint)
    }
}

@Composable
private fun laneDisplayColor(raw: String?): Color {
    val normalized = raw?.removePrefix("#")
    val value = normalized?.toLongOrNull(16)
    val argb = if (normalized == null || value == null) 0xFFD97706L
    else if (normalized.length <= 6) value or 0xFF000000L else value
    return readableOnLightArgb(argb, AdeTokens.colors.isDark).toComposeColor()
}

@Composable
private fun ProjectIcon(dataUrl: String?, name: String, monogramTint: Color? = null) {
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
            Text(
                projectMonogram(name),
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                lineHeight = 14.sp,
                color = monogramTint ?: MaterialTheme.colorScheme.onSurfaceVariant,
            )
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
    laneTint: Color? = null,
) {
    var menuOpen by remember(chat.id) { mutableStateOf(false) }
    val isChat = chat.provider != null || chat.toolType?.contains("chat", ignoreCase = true) == true
    // Roster rows carry `provider` only for rows the host could attribute to a
    // chat; tracked CLI rows arrive with provider=null and just a `toolType`.
    // Derive the same way the Work tab does, or every such row renders as a
    // generic shell tile. `isChat` above deliberately still reads the RAW
    // provider -- deriving into it would reclassify tracked CLI rows as chats.
    val rowProvider = chat.provider ?: providerFromToolType(chat.toolType)
    Row(
        Modifier.fillMaxWidth()
            .padding(start = if (nested) 26.dp else 8.dp)
            .clip(RoundedCornerShape(9.dp))
            .combinedClickable(
                onClick = { onOpenSession(chat.id) },
                onLongClick = { menuOpen = true },
            )
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Branded provider tile shared with the Work tab. Providerless shells
        // fall back to the lane's colour so a lane's rows read as a group
        // instead of a column of identical accent-purple glyphs.
        ProviderMark(rowProvider, isChat, fallbackTint = laneTint)
        Column(Modifier.weight(1f).padding(start = 9.dp)) {
            Text(
                chat.title ?: if (nested) "Attached shell" else "Untitled",
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(rowProvider?.replaceFirstChar(Char::uppercase), relativeActivity(chat.lastActivityAt)).joinToString(" · ")
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

/**
 * Roster/personal-chat rows reuse the Work tab's branded provider tile
 * (`ProviderTile` in WorkComponents.kt + `providerTintArgb` in
 * WorkPresentation.kt) so a Codex chat looks the same everywhere in the app.
 */
@Composable
private fun ProviderMark(provider: String?, isChat: Boolean, size: Int = 26, fallbackTint: Color? = null) {
    val colors = AdeTokens.colors
    val accent = fallbackTint ?: colors.accent
    val accentArgb = accent.toArgb().toLong() and 0xFFFFFFFFL
    val kind = if (isChat) SessionKind.CHAT else SessionKind.TERMINAL
    ProviderTile(provider, kind, providerTintArgb(provider, accentArgb).toComposeColor(), size)
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
    val colors = AdeTokens.colors
    val laneName = laneId?.let { id -> roster.firstOrNull { it.projectId == project?.id }?.lanes?.firstOrNull { it.id == id }?.name }
    val canSend = project != null && (laneId != null || canCreateLane) &&
        (if (cli) canStartCli else canStartChat) &&
        (text.isNotBlank() || (!cli && attachment != null))
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = if (colors.isDark) Color(0xFF17152A) else Color(0xFFFCFBF9),
        contentColor = colors.textPrimary,
        // Material's default scrim is barely visible against the dark Hub, so
        // the sheet read as a panel welded onto a fully-live page.
        scrimColor = Color(0xFF06050A).copy(alpha = if (colors.isDark) 0.62f else 0.34f),
        dragHandle = {
            Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                Box(
                    Modifier.size(width = 34.dp, height = 4.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(colors.border),
                )
            }
        },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = 18.dp)
                .padding(bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // The prompt leads, as in iOS's HubComposerDrawer: the destination
            // controls are a qualifier on the thing you are typing, not a wizard
            // step ahead of it.
            AdeTextField(
                text,
                { text = it; onDraftChange(it) },
                if (cli) "What should the CLI session start on?" else "What should the agent do?",
                singleLine = false,
                minLines = 3,
            )
            attachment?.let { uri ->
                Row(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.accent.copy(alpha = 0.10f))
                        .border(0.75.dp, colors.accent.copy(alpha = 0.26f), RoundedCornerShape(10.dp))
                        .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Image, null, Modifier.size(14.dp), tint = colors.accent)
                    Text(
                        uri.lastPathSegment ?: "Image attachment",
                        Modifier.weight(1f).padding(horizontal = 8.dp),
                        color = colors.textSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.MiddleEllipsis,
                    )
                    IconButton({ attachment = null }, Modifier.size(28.dp)) {
                        Icon(Icons.Rounded.Close, "Remove attachment", Modifier.size(14.dp), tint = colors.textMuted)
                    }
                }
            }

            // Destination row: project · lane.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ComposerPickerChip(
                    label = project?.displayName ?: "Project",
                    icon = Icons.Rounded.FolderOpen,
                    modifier = Modifier.weight(1f),
                    expanded = projectMenu,
                    onExpand = { projectMenu = it },
                ) {
                    projects.forEach { item ->
                        ComposerMenuItem(item.displayName, selected = item.id == project?.id) {
                            project = item; laneId = null; projectMenu = false; persistPreferences()
                        }
                    }
                }
                ComposerPickerChip(
                    label = laneName ?: "New lane",
                    icon = Icons.Rounded.AltRoute,
                    modifier = Modifier.weight(1f),
                    enabled = project != null,
                    expanded = laneMenu,
                    onExpand = { laneMenu = it },
                ) {
                    ComposerMenuItem("New lane", selected = laneId == null) {
                        laneId = null; laneMenu = false; persistPreferences()
                    }
                    roster.firstOrNull { it.projectId == project?.id }?.lanes.orEmpty().forEach { lane ->
                        ComposerMenuItem(lane.name, selected = lane.id == laneId) {
                            laneId = lane.id; laneMenu = false; persistPreferences()
                        }
                    }
                }
            }

            // Agent row: Chat/CLI segmented control, then model.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                ComposerSegmented(
                    options = listOf(false to "Chat", true to "CLI"),
                    selected = cli,
                    onSelect = { cli = it; persistPreferences() },
                )
                ComposerPickerChip(
                    label = model?.name ?: "Default model",
                    icon = Icons.Rounded.AutoAwesome,
                    modifier = Modifier.weight(1f),
                    expanded = modelMenu,
                    onExpand = { modelMenu = it },
                ) {
                    models.forEach { item ->
                        ComposerMenuItem("${item.name} · ${item.provider}", selected = item.id == model?.id) {
                            model = item; reasoning = item.defaultReasoning; modelMenu = false; persistPreferences()
                        }
                    }
                }
            }

            // Behaviour row: permission mode · reasoning · attach · send.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                ComposerPickerChip(
                    label = permissionMode.replace('-', ' '),
                    icon = Icons.Rounded.Tune,
                    modifier = Modifier.weight(1f),
                    expanded = modeMenu,
                    onExpand = { modeMenu = it },
                ) {
                    listOf("default", "plan", "edit", "full-auto").forEach { item ->
                        ComposerMenuItem(item.replace('-', ' '), selected = item == permissionMode) {
                            permissionMode = item; modeMenu = false; persistPreferences()
                        }
                    }
                }
                val reasoningSupported = model?.reasoningEfforts?.isNotEmpty() == true
                ComposerPickerChip(
                    label = if (reasoningSupported) (reasoning ?: "Reasoning") else "No reasoning",
                    icon = Icons.Rounded.Speed,
                    modifier = Modifier.weight(1f),
                    enabled = reasoningSupported,
                    expanded = reasoningMenu,
                    onExpand = { reasoningMenu = it },
                ) {
                    model?.reasoningEfforts.orEmpty().forEach { item ->
                        ComposerMenuItem(item, selected = item == reasoning) {
                            reasoning = item; reasoningMenu = false; persistPreferences()
                        }
                    }
                }
                ComposerRoundButton(
                    icon = Icons.Rounded.Image,
                    description = "Attach image",
                    enabled = !cli && attachmentsEnabled,
                    onClick = { attachmentPicker.launch("image/*") },
                )
                ComposerRoundButton(
                    icon = Icons.Rounded.ArrowUpward,
                    description = "Start work",
                    enabled = canSend,
                    filled = true,
                    onClick = { project?.let { onSend(it, laneId, text.trim(), cli, model, permissionMode, reasoning, attachment) } },
                )
            }
        }
    }
}

/** Token-styled dropdown trigger used by the Hub composer control rows. */
@Composable
private fun ComposerPickerChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    expanded: Boolean,
    onExpand: (Boolean) -> Unit,
    menu: @Composable ColumnScope.() -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(11.dp)
    val tint = if (enabled) colors.textSecondary else colors.textMuted.copy(alpha = 0.55f)
    Box(modifier) {
        Row(
            Modifier.fillMaxWidth()
                .height(38.dp)
                .clip(shape)
                .background(colors.surface.copy(alpha = if (colors.isDark) 0.55f else 0.85f))
                .border(0.75.dp, colors.border, shape)
                .then(if (enabled) Modifier.pressableCard { onExpand(true) } else Modifier)
                .padding(horizontal = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, null, Modifier.size(14.dp), tint = if (enabled) colors.accent else tint)
            Text(
                label,
                Modifier.weight(1f).padding(horizontal = 6.dp),
                color = if (enabled) colors.textPrimary else tint,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                // Model names ("gpt-5.6-terra-preview") and lane names both run
                // long in a third-width chip; the middle is the throwaway part.
                overflow = TextOverflow.MiddleEllipsis,
            )
            Icon(Icons.Rounded.ExpandMore, null, Modifier.size(14.dp), tint = tint)
        }
        DropdownMenu(
            expanded,
            { onExpand(false) },
            modifier = Modifier.background(if (colors.isDark) Color(0xFF1C1A2E) else Color(0xFFFCFBF9)),
        ) {
            menu()
        }
    }
}

@Composable
private fun ComposerMenuItem(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    DropdownMenuItem(
        text = {
            Text(
                label,
                color = if (selected) colors.accent else colors.textPrimary,
                fontSize = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        },
        onClick = onClick,
    )
}

/**
 * Chat/CLI segmented control. This was a [Switch], which reads as "turn CLI on"
 * rather than "pick one of two session kinds" — the two options are peers.
 */
@Composable
private fun <T> ComposerSegmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(11.dp)
    Row(
        Modifier.height(38.dp)
            .clip(shape)
            .background(colors.recessed.copy(alpha = if (colors.isDark) 0.75f else 1f))
            .border(0.75.dp, colors.border, shape)
            .padding(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { (value, label) ->
            val active = value == selected
            Box(
                Modifier.fillMaxHeight()
                    .clip(RoundedCornerShape(9.dp))
                    .background(if (active) colors.accent.copy(alpha = 0.18f) else Color.Transparent)
                    .pressableCard { onSelect(value) }
                    .padding(horizontal = 11.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (active) colors.accent else colors.textMuted,
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun ComposerRoundButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    enabled: Boolean,
    filled: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = AdeTokens.colors
    val tint = when {
        !enabled -> colors.textMuted.copy(alpha = 0.5f)
        filled -> colors.onAccent
        else -> colors.accent
    }
    Box(
        Modifier.size(38.dp)
            .clip(CircleShape)
            .background(
                when {
                    filled && enabled -> colors.accent
                    filled -> colors.accent.copy(alpha = 0.28f)
                    else -> colors.surface.copy(alpha = if (colors.isDark) 0.55f else 0.85f)
                },
            )
            .border(0.75.dp, if (filled) Color.Transparent else colors.border, CircleShape)
            .then(if (enabled) Modifier.pressableCard(onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, Modifier.size(17.dp), tint = tint)
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
    var addLaneOpen by remember { mutableStateOf(false) }
    val accentArgb = if (AdeTokens.colors.isDark) 0xFFA78BFAL else 0xFF049068L
    // Both cards are built from the two payloads the app already fetches:
    // `work.listSessions` (timestamps, status note, attention text, pin state,
    // summary/goal) and `lanes.refreshSnapshots` with includeStatus (colour,
    // dirty/ahead/behind, childCount, Linear id, devicesOpen). No per-lane
    // `lanes.getDetail` fan-out is needed for either tab.
    val lanesById = remember(state.lanes) { state.lanes.associateBy(UiLane::id) }
    val workCards = state.sessions.map { session ->
        workCardModel(
            session = session,
            lane = session.laneId?.let(lanesById::get),
            accentArgb = accentArgb,
        )
    }
    Box(Modifier.fillMaxSize()) {
        AdeAuroraBackground()
        Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            val colors = AdeTokens.colors
            Row(
                Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    Modifier.clip(CircleShape)
                        .background(colors.glass)
                        .border(1.dp, Color.White.copy(alpha = 0.12f), CircleShape)
                        .pressableCard(onBack)
                        .padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back to Hub", Modifier.size(14.dp), tint = colors.accent)
                    Surface(
                        Modifier.size(24.dp),
                        shape = RoundedCornerShape(6.dp),
                        color = colors.accent.copy(alpha = 0.12f),
                    ) { ProjectIcon(project?.iconDataUrl, project?.displayName ?: "Project") }
                }
                Text(
                    if (tab == "work") "Work" else "Lanes",
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Black,
                    color = colors.textPrimary,
                    maxLines = 1,
                )
                Spacer(Modifier.weight(1f))
                if (tab == "work") WorkLivePill(workLiveCounts(workCards))
                Surface(
                    shape = CircleShape,
                    color = colors.glass,
                    border = androidx.compose.foundation.BorderStroke(1.dp, colors.glassBorder),
                ) {
                    // iOS groups a bell beside the gear here; Android v1 keeps
                    // attention on the Hub screen, so the pill carries settings only.
                    IconButton(onClick = onSettings, modifier = Modifier.size(34.dp)) {
                        Icon(Icons.Rounded.Settings, "Settings", Modifier.size(16.dp), tint = colors.textSecondary)
                    }
                }
            }
        },
        bottomBar = {
            Box(Modifier.navigationBarsPadding()) {
                AdeFloatingTabBar(
                    items = listOf(
                        AdeTabItem("work", "Work", badge = workCards.count { normalizeWorkStatus(it.status) == "active" }),
                        AdeTabItem("lanes", "Lanes"),
                    ),
                    selected = tab,
                    onSelect = { tab = it },
                ) { id, selected ->
                    Icon(
                        if (id == "work") Icons.Rounded.ChatBubbleOutline else Icons.Rounded.FolderOpen,
                        null,
                        Modifier.size(17.dp),
                        tint = if (selected) AdeTokens.colors.onAccent else AdeTokens.colors.textSecondary,
                    )
                }
            }
        },
        ) { padding ->
        if (tab == "work") WorkList(
            cards = workCards,
            lanes = state.lanes,
            viewModel = viewModel,
            projectId = project?.id,
            collapsedKeys = state.workCollapsedKeys,
            offline = project == null,
            modifier = Modifier.padding(padding),
            onSession = onSession,
            onStartChat = { composerOpen = true },
            onAddLane = { addLaneOpen = true },
        )
        else LaneList(
            state.lanes,
            viewModel,
            Modifier.padding(padding),
            onAddLane = { addLaneOpen = true },
        )
        }
    }
    if (addLaneOpen) AddLaneDialog(
        onDismiss = { addLaneOpen = false },
        onCreate = { name, baseRef -> viewModel.createLane(name, baseRef) },
    )
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

/** "Add lane" dialog. Gated by the caller on the `lanes.create` descriptor. */
@Composable
private fun AddLaneDialog(onDismiss: () -> Unit, onCreate: (String, String?) -> Unit) {
    var name by remember { mutableStateOf("") }
    var baseRef by remember { mutableStateOf("") }
    AdeDialog(
        title = "New lane",
        onDismiss = onDismiss,
        icon = Icons.Rounded.Add,
        confirmLabel = "Create",
        confirmEnabled = name.isNotBlank(),
        onConfirm = { onCreate(name.trim(), baseRef.trim().takeIf(String::isNotEmpty)); onDismiss() },
    ) {
        AdeTextField(name, { name = it }, "Name")
        AdeTextField(baseRef, { baseRef = it }, "Base branch (optional)")
        AdeDialogText("Leave the base blank to use this project's configured default.")
    }
}

@Composable
private fun WorkList(
    cards: List<WorkCardModel>,
    lanes: List<UiLane>,
    viewModel: MainViewModel,
    projectId: String?,
    collapsedKeys: Set<String>,
    offline: Boolean,
    modifier: Modifier,
    onSession: (UiSession) -> Unit,
    onStartChat: () -> Unit,
    onAddLane: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    // Search text, filters and grouping persist per project + host, matching the
    // iOS `ade.work.viewStateByScope.v1` store.
    val scope = projectId.orEmpty()
    val persisted = state.workViewStates[scope] ?: WorkViewState()
    var filtersOpen by remember { mutableStateOf(false) }
    var view by remember(scope, persisted) { mutableStateOf(persisted) }
    fun update(next: WorkViewState) {
        view = next
        if (projectId != null) viewModel.setWorkViewState(scope, next)
    }
    val query = view.query
    val statusFilter = view.statusFilter
    val laneFilter = view.laneFilter
    val organization = runCatching { WorkOrganization.valueOf(view.organization) }
        .getOrDefault(WorkOrganization.BY_LANE)

    val filtered = cards
        .filter { matchesWorkSearch(it, query) }
        .filter { statusFilter == "all" || normalizeWorkStatus(it.status) == statusFilter }
        .filter { laneFilter == null || it.laneId == laneFilter }
    val groups = when (organization) {
        WorkOrganization.BY_LANE -> groupWorkByLane(filtered, lanes)
        WorkOrganization.BY_STATUS -> groupWorkByStatus(filtered)
        WorkOrganization.BY_TIME -> groupWorkByTime(filtered)
    }
    val sessionsById = state.sessions.associateBy(UiSession::id)

    LazyColumn(
        modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 8.dp, bottom = 124.dp),
    ) {
        item { WorkSearchRow(query, { update(view.copy(query = it)) }, filtersOpen) { filtersOpen = !filtersOpen } }
        item { WorkActionRow(offline, onStartChat = onStartChat, onAddLane = onAddLane) }
        if (filtersOpen) item {
            WorkFilterPanel(
                statusFilter = statusFilter,
                onStatusFilter = { update(view.copy(statusFilter = it)) },
                organization = organization,
                onOrganization = { update(view.copy(organization = it.name)) },
                laneOptions = listOf<Pair<String?, String>>(null to "All lanes") +
                    lanes.map { it.id as String? to it.name },
                laneFilter = laneFilter,
                onLaneFilter = { update(view.copy(laneFilter = it)) },
            )
        }
        if (groups.isEmpty()) item {
            AdeCard(color = MaterialTheme.colorScheme.surface.copy(alpha = 0.62f)) {
                Text(if (cards.isEmpty()) "No active work" else "No matching sessions", fontWeight = FontWeight.SemiBold)
                Text(
                    if (cards.isEmpty()) "Start a chat or terminal session above."
                    else "Try another title, lane, or phrase.",
                    Modifier.padding(top = 4.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        groups.forEach { group ->
            // Collapse state persists per project + host under its own DataStore
            // key. Quiet groups invert the default, so for them the stored key
            // means "explicitly opened" instead of "collapsed".
            val stored = "$scope:${group.id}" in collapsedKeys
            val collapsed = if (group.quiet) !stored else stored
            item(key = "header-${group.id}") {
                WorkGroupHeader(group, collapsed) {
                    if (projectId != null) viewModel.setWorkCollapsed(scope, group.id, !stored)
                }
            }
            if (!collapsed) items(group.cards, key = { "card-${it.id}" }) { card ->
                WorkSessionCard(card, onClick = { sessionsById[card.id]?.let(onSession) })
            }
        }
    }
}

@Composable
private fun LaneList(lanes: List<UiLane>, viewModel: MainViewModel, modifier: Modifier, onAddLane: () -> Unit) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    var expandedLane by remember { mutableStateOf<String?>(null) }
    var renamingLane by remember { mutableStateOf<UiLane?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deletingLane by remember { mutableStateOf<UiLane?>(null) }
    renamingLane?.let { lane ->
        AdeDialog(
            title = "Rename lane",
            onDismiss = { renamingLane = null },
            icon = Icons.Rounded.Edit,
            confirmLabel = "Save",
            confirmEnabled = renameText.isNotBlank(),
            onConfirm = { viewModel.renameLane(lane.id, renameText); renamingLane = null },
        ) {
            AdeTextField(renameText, { renameText = it }, "Name")
        }
    }
    deletingLane?.let { lane ->
        AdeDialog(
            title = "Delete ${lane.name}?",
            onDismiss = { deletingLane = null },
            icon = Icons.Rounded.Delete,
            destructive = true,
            confirmLabel = "Delete",
            onConfirm = { viewModel.runLaneAction("lanes.delete", lane.id); deletingLane = null },
        ) {
            AdeDialogText("This removes the lane worktree. This action cannot be undone from Android.")
        }
    }
    LazyColumn(
        modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            top = 8.dp,
            start = 16.dp,
            end = 16.dp,
            bottom = 124.dp,
        ),
    ) {
        item { LaneAddButton(enabled = viewModel.canInvoke("lanes.create"), onClick = onAddLane) }
        item { LaneSectionLabel("LANES") }
        if (lanes.isEmpty()) item {
            AdeCard(color = MaterialTheme.colorScheme.surface.copy(alpha = 0.62f)) {
                Text("No lanes yet", fontWeight = FontWeight.SemiBold)
                Text("Create one when starting new work.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        items(lanes, key = UiLane::id) { lane ->
            val expanded = expandedLane == lane.id
            val detail = state.laneDetails[lane.id]
            // The card renders entirely from the `lanes.refreshSnapshots`
            // snapshot; `lanes.getDetail` is fetched only when the row is
            // expanded, for commits/sessions/upstream.
            val model = LaneCardModel(
                id = lane.id,
                name = lane.name,
                branch = lane.branch,
                colorArgb = parseLaneColorArgb(lane.color) ?: laneFallbackColorArgb(lane.id),
                laneType = lane.laneType,
                archived = lane.archived,
                git = laneGitState(lane),
                devicesOpen = lane.devicesOpen,
            )
            Column {
            LaneCard(model, open = expanded, onClick = {
                expandedLane = if (expanded) null else lane.id
                if (!expanded) viewModel.refreshLaneDetail(lane.id)
            })
                if (expanded) {
                    lane.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    if (detail == null) Text("Loading lane detail…", style = MaterialTheme.typography.bodySmall)
                    else {
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

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

private val previewProjects = listOf(
    MobileProject(id = "p-ade", displayName = "ADE", laneCount = 6),
    MobileProject(id = "p-win", displayName = "ade-win-smoke-9f2c41", laneCount = 1),
    MobileProject(id = "p-crumb", displayName = "crumb", laneCount = 1),
)

private val previewRoster = RosterProject(
    projectId = "p-ade",
    displayName = "ADE",
    lanes = listOf(
        RosterLane(id = "l1", name = "android app feasibility", color = "#A78BFA"),
        RosterLane(id = "l2", name = "windows native build", color = "#0A84FF"),
    ),
    chats = listOf(
        RosterChat(id = "c1", laneId = "l1", title = "Wire the Hub composer", provider = "codex", status = "running"),
        RosterChat(id = "c2", laneId = "l1", title = "Lane snapshot parser", provider = "claude", status = "idle"),
        RosterChat(id = "c3", laneId = "l2", title = "MSI packaging", provider = null, status = "idle"),
    ),
)

@androidx.compose.ui.tooling.preview.Preview(name = "Hub project rows dark", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewHubProjectsDark() = AdeTheme(dark = true) { PreviewHubProjects() }

@androidx.compose.ui.tooling.preview.Preview(name = "Hub project rows light", showBackground = true, backgroundColor = 0xFFF5F3F0)
@Composable
private fun PreviewHubProjectsLight() = AdeTheme(dark = false) { PreviewHubProjects() }

@Composable
private fun PreviewHubProjects() {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionTitle("Projects", "Live work across this machine", Modifier.weight(1f))
            IconButton(onClick = {}) { Icon(Icons.Rounded.Refresh, "Refresh") }
        }
        previewProjects.forEachIndexed { index, project ->
            ProjectCard(
                project = project,
                roster = if (index == 0) previewRoster else null,
                collapsed = index != 0,
                onToggle = {},
                onOpen = {},
                onOpenSession = {},
                onArchiveSession = {},
                onCloseSession = {},
                canArchive = true,
                canClose = true,
                collapsedLaneKeys = emptySet(),
                onToggleLane = { _, _ -> },
            )
        }
        HubComposerPill(draft = "", onClick = {})
    }
}
