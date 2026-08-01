package com.ade.android.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ade.android.MainViewModel
import com.ade.android.SessionKind
import com.ade.android.UiSession
import com.ade.android.data.Appearance
import com.ade.android.security.MachineProfile
import com.ade.sync.model.DirectoryMachine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.connectbot.terminal.Terminal
import org.connectbot.terminal.TerminalEmulator
import org.connectbot.terminal.TerminalEmulatorFactory

@Composable
fun SessionScreen(viewModel: MainViewModel, sessionId: String, onBack: () -> Unit) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val session = state.sessions.firstOrNull { it.id == sessionId }
        ?: state.personalChats.firstOrNull { it.id == sessionId }
    LaunchedEffect(sessionId, session?.id) {
        session?.let(viewModel::openSession)
    }
    DisposableEffect(sessionId) {
        onDispose { viewModel.closeSession() }
    }
    AdeScreen(session?.title ?: "Session", onBack) {
        if (session == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("This session is no longer in the active project.")
            }
        } else if (session.isTerminal()) {
            TerminalSession(
                viewModel,
                state.terminalData,
                canLoadEarlier = !state.terminalAtStart && (state.terminalStartOffset ?: 0) > 0,
            )
        } else {
            ChatSession(
                viewModel,
                session,
                state.transcript,
                state.historyHasMore,
                (state.attentionPreferences?.get("mutedSessionIds") as? JsonArray).orEmpty()
                    .any { it.jsonPrimitive.contentOrNull == session.id },
                canApprove = viewModel.canInvokeChat("approve", session.personal),
                canSend = viewModel.canInvokeChat("send", session.personal),
                canAttach = viewModel.canInvokeChat("saveTempAttachment", session.personal),
                canMute = state.signedIn,
            )
        }
    }
}

@Composable
private fun ChatSession(
    viewModel: MainViewModel,
    session: UiSession,
    events: List<JsonObject>,
    hasOlderHistory: Boolean,
    muted: Boolean,
    canApprove: Boolean,
    canSend: Boolean,
    canAttach: Boolean,
    canMute: Boolean,
) {
    var message by remember(session.id) { mutableStateOf("") }
    var attachment by remember(session.id) { mutableStateOf<Uri?>(null) }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        attachment = uri
    }
    val listState = rememberLazyListState()
    LaunchedEffect(events.size) {
        if (events.isNotEmpty()) listState.animateScrollToItem(events.lastIndex)
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(viewModel::loadOlderChat, enabled = hasOlderHistory) {
                Text(if (hasOlderHistory) "Load earlier messages" else "Start of conversation")
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { viewModel.toggleSessionMute(session.id) }, enabled = canMute) {
                Icon(if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp, if (muted) "Unmute session" else "Mute session")
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            itemsIndexed(events, key = { index, event ->
                event.string("id")
                    ?: event.string("eventId")
                    ?: event.string("sequence")
                    ?: event.string("seq")
                    ?: "${event.string("timestamp").orEmpty()}:$index"
            }) { _, event ->
                ChatEventRow(viewModel, session.id, event, canApprove)
            }
            if (events.isEmpty()) item { Text("Waiting for chat history…", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        session.pendingInputItemId?.let { itemId ->
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Approval required", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                OutlinedButton(onClick = { viewModel.approve(session.id, itemId, false) }, enabled = canApprove) { Text("Deny") }
                Button(onClick = { viewModel.approve(session.id, itemId, true) }, enabled = canApprove) { Text("Approve") }
            }
        }
        HorizontalDivider()
        attachment?.let { uri ->
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(uri.lastPathSegment ?: "Image attachment", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = { attachment = null }) { Icon(Icons.Rounded.Close, "Remove attachment") }
            }
        }
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.Bottom) {
            IconButton(onClick = { attachmentPicker.launch("image/*") }, enabled = canAttach) {
                Icon(Icons.Rounded.Add, "Attach image")
            }
            OutlinedTextField(
                value = message,
                onValueChange = { message = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message") },
                maxLines = 5,
            )
            IconButton(
                onClick = { viewModel.sendChat(message, attachment); message = ""; attachment = null },
                enabled = canSend && (message.isNotBlank() || attachment != null),
            ) { Icon(Icons.AutoMirrored.Rounded.Send, "Send") }
        }
    }
}

@Composable
private fun ChatEventRow(viewModel: MainViewModel, sessionId: String, event: JsonObject, canApprove: Boolean) {
    val type = event.string("type") ?: event.string("kind") ?: "event"
    val role = event.string("role")
    val payload = event["payload"] as? JsonObject
    val text = eventText(event)
    val patch = event.string("patch") ?: event.string("diff") ?: payload?.string("patch") ?: payload?.string("diff")
    val approvalItemId = event.string("itemId") ?: payload?.string("itemId")
    val title = when {
        role != null -> role.replaceFirstChar(Char::uppercase)
        type.contains("tool", true) -> event.string("toolName") ?: payload?.string("toolName") ?: "Tool"
        patch != null -> "File changes"
        type.contains("approval", true) || type.contains("permission", true) -> "Approval"
        else -> type.replace('_', ' ')
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        if (patch != null) {
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(9.dp)) {
                patch.lineSequence().take(160).forEach { line ->
                    Text(
                        line,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        color = when {
                            line.startsWith("+") && !line.startsWith("+++") -> Color(0xFF15803D)
                            line.startsWith("-") && !line.startsWith("---") -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        } else {
            Text(
                text ?: compactEventText(event),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = if (text == null) 12 else Int.MAX_VALUE,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (approvalItemId != null && (type.contains("approval", true) || type.contains("permission", true))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton({ viewModel.approve(sessionId, approvalItemId, false) }, enabled = canApprove) { Text("Deny") }
                Button({ viewModel.approve(sessionId, approvalItemId, true) }, enabled = canApprove) { Text("Approve") }
            }
        }
    }
}

private fun eventText(event: JsonObject): String? {
    listOf("text", "message", "content", "output").forEach { key ->
        event.string(key)?.let { return it }
    }
    listOf("delta", "payload", "message", "content").forEach { key ->
        when (val nested = event[key]) {
            is JsonObject -> eventText(nested)?.let { return it }
            is JsonArray -> nested.mapNotNull { part ->
                when (part) {
                    is JsonObject -> eventText(part)
                    is JsonPrimitive -> part.contentOrNull
                    else -> null
                }
            }.takeIf(List<String>::isNotEmpty)?.joinToString("")?.let { return it }
            else -> Unit
        }
    }
    return null
}

private fun compactEventText(event: JsonObject): String = event.entries.joinToString("\n") { (key, value) ->
    val rendered = when (value) {
        is JsonPrimitive -> value.contentOrNull.orEmpty()
        is JsonArray -> "${value.size} items"
        is JsonObject -> value.string("summary") ?: value.string("status") ?: "details"
    }
    "$key: $rendered"
}

@Composable
private fun TerminalSession(viewModel: MainViewModel, output: String, canLoadEarlier: Boolean) {
    lateinit var terminal: TerminalEmulator
    terminal = remember {
        TerminalEmulatorFactory.create(
            initialRows = 24,
            initialCols = 80,
            defaultForeground = Color(0xFFF4F4F5),
            defaultBackground = Color(0xFF111214),
            onKeyboardInput = { viewModel.sendTerminalInput(it.toString(Charsets.UTF_8)) },
            onResize = { size -> viewModel.resizeTerminal(size.rows, size.columns) },
            autoDetectUrls = true,
        )
    }
    var written by remember { mutableStateOf("") }
    LaunchedEffect(output) {
        if (!output.startsWith(written)) {
            terminal.clearScreen()
            written = ""
        }
        if (output.length > written.length) {
            terminal.writeInput(output.substring(written.length).toByteArray())
            written = output
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (canLoadEarlier) {
            TextButton(onClick = viewModel::loadOlderTerminal, modifier = Modifier.fillMaxWidth()) {
                Text("Load earlier output")
            }
        }
        Terminal(
            terminalEmulator = terminal,
            modifier = Modifier.fillMaxWidth().weight(1f),
            typeface = Typeface.MONOSPACE,
            backgroundColor = Color(0xFF111214),
            foregroundColor = Color(0xFFF4F4F5),
            keyboardEnabled = true,
            showSoftKeyboard = true,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SettingsScreen(
    viewModel: MainViewModel,
    activity: Activity,
    onBack: () -> Unit,
    onPair: () -> Unit,
    onSignedOut: () -> Unit,
    onForgot: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val status by viewModel.syncStatus.collectAsStateWithLifecycle()
    val hello by viewModel.hello.collectAsStateWithLifecycle()
    val appearance by viewModel.appearance.collectAsStateWithLifecycle(Appearance.SYSTEM)
    val analytics by viewModel.analyticsEnabled.collectAsStateWithLifecycle(true)
    val push by viewModel.pushEnabled.collectAsStateWithLifecycle(false)
    val machine = viewModel.currentMachine()
    var showForget by remember { mutableStateOf(false) }
    var showPushPrimer by remember { mutableStateOf(false) }
    var rename by remember(machine?.machineKey) { mutableStateOf(machine?.name.orEmpty()) }
    var listRename by remember { mutableStateOf<SettingsMachineItem?>(null) }
    var listRenameText by remember { mutableStateOf("") }
    val matchedDirectoryKeys = mutableSetOf<String>()
    val machineItems = buildList {
        state.savedMachines.forEach { saved ->
            val directory = state.machines.firstOrNull(saved::matches)
            directory?.machineKey?.let(matchedDirectoryKeys::add)
            add(SettingsMachineItem(
                machineKey = saved.machineKey,
                name = directory?.customName ?: directory?.name ?: saved.name,
                saved = saved,
                directory = directory,
                current = saved.machineKey == machine?.machineKey,
                online = directory?.online == true,
            ))
        }
        state.machines.filterNot { it.machineKey in matchedDirectoryKeys }.forEach { directory ->
            add(SettingsMachineItem(
                machineKey = directory.machineKey,
                name = directory.customName ?: directory.name ?: "ADE machine",
                saved = null,
                directory = directory,
                current = false,
                online = directory.online,
            ))
        }
    }.sortedWith(compareBy<SettingsMachineItem> { if (it.current) 0 else if (it.online) 1 else 2 }.thenBy { it.name.lowercase() })
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        viewModel.setPushEnabled(granted)
    }
    LaunchedEffect(state.signedIn) { if (state.signedIn) viewModel.refreshDirectory() }

    if (showForget && machine != null) AlertDialog(
        onDismissRequest = { showForget = false },
        title = { Text("Forget ${machine.name}?") },
        text = { Text("This deletes the paired secret and device key. Pair again to reconnect.") },
        confirmButton = {
            TextButton(onClick = { viewModel.forget(machine.machineKey); showForget = false; onForgot() }) {
                Text("Forget", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { showForget = false }) { Text("Cancel") } },
    )
    if (showPushPrimer) AlertDialog(
        onDismissRequest = { showPushPrimer = false },
        title = { Text("Allow agent notifications?") },
        text = { Text("ADE will notify you only for approvals and attention events allowed by your settings. Every alert opens the relevant work, and you can turn it off here at any time.") },
        confirmButton = {
            TextButton({
                showPushPrimer = false
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }) { Text("Continue") }
        },
        dismissButton = { TextButton({ showPushPrimer = false }) { Text("Not now") } },
    )
    listRename?.let { target ->
        AlertDialog(
            onDismissRequest = { listRename = null },
            title = { Text("Rename ${target.name}") },
            text = { OutlinedTextField(listRenameText, { listRenameText = it.take(80) }, label = { Text("Display name") }) },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.renameMachine(target.machineKey, listRenameText); listRename = null },
                    enabled = listRenameText.isNotBlank(),
                ) { Text("Save") }
            },
            dismissButton = { TextButton({ listRename = null }) { Text("Cancel") } },
        )
    }

    AdeScreen("Settings", onBack) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { SectionTitle("Account") }
            item {
                AdeCard {
                    Text(if (state.signedIn) "Signed in to ADE" else "Using ADE without an account", fontWeight = FontWeight.SemiBold)
                    if (state.signedIn) {
                        state.accountName?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        state.accountEmail?.takeIf { it != state.accountName }?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Text(
                        if (state.signedIn) "Machine discovery and account attention are available."
                        else "Saved paired machines remain available over direct routes.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (state.signedIn) TextButton(onClick = { viewModel.signOut(); onSignedOut() }) { Text("Sign out") }
                }
            }
            item { SectionTitle("Connection") }
            item {
                AdeCard {
                    Text(machine?.name ?: "No machine", fontWeight = FontWeight.SemiBold)
                    Text("${status.state} · ${status.route ?: "no route"}", style = MaterialTheme.typography.bodySmall)
                    status.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    hello?.features?.mobileCompatibility?.takeIf { it.mode != "full" || it.missingActions.isNotEmpty() }?.let { compatibility ->
                        Text(
                            "This machine is missing ${compatibility.missingActions.size} Android actions. Update ADE for full controls.",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (machine != null) {
                        OutlinedTextField(rename, { rename = it.take(80) }, Modifier.fillMaxWidth().padding(top = 10.dp), label = { Text("Display name") })
                        TextButton(onClick = { viewModel.renameMachine(machine.machineKey, rename) }, enabled = rename.isNotBlank()) { Text("Save name") }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = viewModel::disconnect, enabled = status.state == "connected") { Text("Disconnect") }
                            Button(onClick = { viewModel.connect(machine) }, enabled = status.state != "connecting") { Text("Reconnect") }
                        }
                        if (status.state == "error") {
                            TextButton(onClick = onPair) { Text("Pair again with PIN") }
                        }
                    }
                }
            }
            item { SectionTitle("Machines") }
            items(machineItems, key = SettingsMachineItem::machineKey) { item ->
                val enabled = item.saved != null || item.directory?.reachableEndpoints?.isNotEmpty() == true
                AdeCard(
                    Modifier.combinedClickable(
                        enabled = enabled,
                        onClick = {
                            item.saved?.let { viewModel.connect(it) }
                                ?: item.directory?.let { viewModel.connectAccount(it) {} }
                        },
                        onLongClick = if (state.signedIn || item.saved != null) {
                            {
                                listRenameText = item.name
                                listRename = item
                            }
                        } else null,
                    ),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(item.name, fontWeight = FontWeight.SemiBold)
                            Text(
                                when {
                                    item.current -> "Current machine"
                                    item.online -> "Online"
                                    item.saved != null -> "Offline · saved pairing"
                                    else -> "Offline"
                                },
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Text(if (enabled) "Connect" else "Unavailable")
                    }
                }
            }
            item { OutlinedButton(onClick = onPair, Modifier.fillMaxWidth()) { Text("Add machine") } }
            item { SectionTitle("Appearance") }
            items(Appearance.entries) { option ->
                Row(
                    Modifier.fillMaxWidth().clickable { viewModel.setAppearance(option) }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(option == appearance, { viewModel.setAppearance(option) })
                    Text(option.name.lowercase().replaceFirstChar(Char::uppercase))
                }
            }
            item { SectionTitle("Privacy and notifications") }
            item {
                SettingToggle(
                    "Product analytics",
                    "Allow privacy-bounded Android usage events through your connected ADE machine.",
                    analytics,
                    viewModel::setAnalyticsEnabled,
                )
            }
            item {
                SettingToggle("Push notifications", "Show approvals and agent attention on this device.", push) { enabled ->
                    if (!enabled) viewModel.setPushEnabled(false)
                    else if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                        viewModel.setPushEnabled(true)
                    } else showPushPrimer = true
                }
            }
            if (state.signedIn) {
                val attentionAccount = state.attentionPreferences?.get("account") as? JsonObject
                item {
                    SettingToggle(
                        "Hide notification details",
                        "Use private notification text on the lock screen.",
                        attentionAccount.flag("hideDetails"),
                    ) { viewModel.setAttentionAccountFlag("hideDetails", it) }
                }
                item {
                    SettingToggle(
                        "Notification sounds",
                        "Play sound for allowed attention events.",
                        attentionAccount.flag("soundsEnabled"),
                    ) { viewModel.setAttentionAccountFlag("soundsEnabled", it) }
                }
                item {
                    SettingToggle(
                        "Desktop first",
                        "Delay phone alerts briefly while ADE is visible on the desktop.",
                        attentionAccount.flag("desktopFirstEnabled", default = true),
                    ) { viewModel.setAttentionAccountFlag("desktopFirstEnabled", it) }
                }
            }
            item { SectionTitle("AI usage") }
            item {
                UsageQuotaCard(state.quota, viewModel::refreshQuota)
            }
            item { SectionTitle("Connection details") }
            item {
                AdeCard {
                    DetailLine("Route", status.route?.name?.lowercase() ?: "Not connected")
                    DetailLine("Machine key", machine?.machineKey?.take(12) ?: "—")
                    DetailLine("Device", machine?.pairedDeviceId ?: "—")
                    DetailLine("Host version", hello?.brain?.appVersion ?: "—")
                    DetailLine("App version", "${com.ade.android.BuildConfig.VERSION_NAME} (${com.ade.android.BuildConfig.VERSION_CODE})")
                }
            }
            if (machine != null) item {
                TextButton(onClick = { showForget = true }, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Close, null)
                    Spacer(Modifier.weight(1f))
                    Text("Forget machine", color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.weight(1f))
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

private data class SettingsMachineItem(
    val machineKey: String,
    val name: String,
    val saved: MachineProfile?,
    val directory: DirectoryMachine?,
    val current: Boolean,
    val online: Boolean,
)

@Composable
private fun SettingToggle(title: String, detail: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, onChecked)
    }
}

@Composable
private fun UsageQuotaCard(quota: JsonElement?, onRefresh: () -> Unit) {
    val source = quota as? JsonObject
    val windows = (source?.get("windows") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    AdeCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Live provider limits", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            TextButton(onClick = onRefresh) { Text("Refresh") }
        }
        if (windows.isEmpty()) {
            Text("Quota data is unavailable on this machine.", style = MaterialTheme.typography.bodySmall)
        } else {
            windows.groupBy { it.string("provider") ?: "provider" }.forEach { (provider, providerWindows) ->
                Text(provider.replaceFirstChar(Char::uppercase), fontWeight = FontWeight.SemiBold)
                providerWindows.forEach { window ->
                    val percent = window["percentUsed"]?.jsonPrimitive?.doubleOrNull?.coerceIn(0.0, 100.0) ?: 0.0
                    Row(Modifier.fillMaxWidth()) {
                        Text(
                            (window.string("windowType") ?: "limit").replace('_', ' ').replaceFirstChar(Char::uppercase),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text("${"%.1f".format(percent)}% used", style = MaterialTheme.typography.bodySmall)
                    }
                    LinearProgressIndicator(
                        progress = { (percent / 100.0).toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val resets = window["resetsInMs"]?.jsonPrimitive?.doubleOrNull?.toLong()
                    if (resets != null) Text("Resets in ${formatDuration(resets)}", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

private fun formatDuration(milliseconds: Long): String {
    val minutes = (milliseconds.coerceAtLeast(0) / 60_000)
    val hours = minutes / 60
    val days = hours / 24
    return when {
        days > 0 -> "${days}d ${hours % 24}h"
        hours > 0 -> "${hours}h ${minutes % 60}m"
        else -> "${minutes}m"
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun UiSession.isTerminal(): Boolean = kind == SessionKind.TERMINAL
private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
private fun JsonObject?.flag(key: String, default: Boolean = false): Boolean =
    this?.get(key)?.jsonPrimitive?.booleanOrNull ?: default
