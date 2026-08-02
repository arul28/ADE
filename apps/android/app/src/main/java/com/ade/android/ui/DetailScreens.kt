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
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ade.android.MainViewModel
import com.ade.android.SessionKind
import com.ade.android.UiModel
import com.ade.android.UiSession
import com.ade.android.data.Appearance
import com.ade.android.security.MachineProfile
import com.ade.sync.model.DirectoryMachine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
    val muted = (state.attentionPreferences?.get("mutedSessionIds") as? JsonArray).orEmpty()
        .any { it.jsonPrimitive.contentOrNull == session?.id }
    AdeScreen(
        session?.title ?: "Session",
        onBack,
        actions = {
            // iOS keeps mute in the navigation bar. Android previously burned a
            // whole transcript row on this single icon.
            if (session != null && !session.isTerminal()) IconButton(
                onClick = { viewModel.toggleSessionMute(session.id) },
                enabled = state.signedIn,
            ) {
                Icon(
                    if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp,
                    if (muted) "Unmute session" else "Mute session",
                )
            }
        },
    ) {
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
                canApprove = viewModel.canInvokeChat("approve", session.personal),
                canSend = viewModel.canInvokeChat("send", session.personal),
                canAttach = viewModel.canInvokeChat("saveTempAttachment", session.personal),
                canSetModel = viewModel.canInvokeChat("updateSession", session.personal),
                canInterrupt = viewModel.canInvokeChat("interrupt", session.personal),
                models = state.models,
                favouriteIds = state.modelFavourites,
                recentIds = state.modelRecents,
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
    canApprove: Boolean,
    canSend: Boolean,
    canAttach: Boolean,
    canSetModel: Boolean,
    canInterrupt: Boolean,
    models: List<UiModel> = emptyList(),
    favouriteIds: Set<String> = emptySet(),
    recentIds: List<String> = emptyList(),
) {
    var message by remember(session.id) { mutableStateOf("") }
    var attachment by remember(session.id) { mutableStateOf<Uri?>(null) }
    var showModelPicker by remember(session.id) { mutableStateOf(false) }
    var approvalDetail by remember(session.id) { mutableStateOf<ChatApproval?>(null) }
    var accessModeIndex by remember(session.id) { mutableStateOf(0) }
    var unreadBelow by remember(session.id) { mutableStateOf(0) }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        attachment = uri
    }
    val listState = rememberLazyListState()
    val colors = AdeTokens.colors

    // The fold is O(events) and re-runs on every streamed delta, so its cost over
    // a whole turn grows quadratically: ~0.35 ms per fold at 100 deltas, but
    // 3-13 ms at 1000-4000 on a desktop JVM — well past the frame budget on a
    // phone. Derive off the main thread so transcript length can never jank the
    // UI, and keep the previous result on screen while the next one computes.
    val adapted = remember(events) { events }
    val transcript by produceState(
        initialValue = EMPTY_CHAT_TRANSCRIPT,
        adapted,
        session.provider,
        session.model,
    ) {
        value = withContext(Dispatchers.Default) {
            foldChatTranscript(ChatEventAdapter.adapt(adapted), session.provider, session.model)
        }
    }
    val options = remember(models) {
        models.map { model ->
            ChatModelOption(
                id = model.id,
                name = model.name,
                provider = model.provider,
                defaultReasoningEffort = model.defaultReasoning,
                reasoningEfforts = model.reasoningEfforts,
                serviceTiers = model.serviceTiers,
            )
        }
    }
    // Seeded from the host's session record (chat.getSummary), so reopening the
    // session shows the model the host actually has, not a local guess.
    var selection by remember(session.id, session.model, session.reasoningEffort, session.fastMode) {
        mutableStateOf(
            ChatModelSelection(
                modelId = session.model,
                effort = session.reasoningEffort?.trim()?.lowercase()
                    ?: models.firstOrNull { it.id == session.model }?.defaultReasoning?.lowercase(),
                fastMode = session.fastMode,
            ),
        )
    }
    val currentOption = options.firstOrNull { it.id == selection.modelId }

    val atBottom = remember(listState, transcript.items.size) {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= (transcript.items.lastIndex - 1)
        }
    }
    // A streaming answer grows *inside* one item, so the item count does not
    // change and keying the follow-scroll on size alone left the new text below
    // the fold — the transcript looked frozen mid-answer. Key on the growing
    // tail as well, and use a non-animated scroll so rapid deltas do not queue
    // up animations behind each other.
    val streamingTail = (transcript.items.lastOrNull() as? ChatTimelineItem.AssistantMessage)?.text?.length ?: 0
    LaunchedEffect(transcript.items.size, streamingTail) {
        if (transcript.items.isEmpty()) return@LaunchedEffect
        if (atBottom.value) {
            listState.scrollToItem(transcript.items.lastIndex)
            unreadBelow = 0
        }
    }
    LaunchedEffect(transcript.items.size) {
        if (transcript.items.isNotEmpty() && !atBottom.value) unreadBelow += 1
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().imePadding().navigationBarsPadding()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).padding(horizontal = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item("load-earlier") {
                    if (hasOlderHistory) {
                        LoadEarlierRow(
                            count = null,
                            loading = false,
                            error = false,
                            onLoad = viewModel::loadOlderChat,
                        )
                    } else {
                        Text(
                            "Start of conversation",
                            Modifier.fillMaxWidth(),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textMuted,
                        )
                    }
                }
                items(transcript.items, key = ChatTimelineItem::id) { item ->
                    ChatTimelineRow(item)
                }
                if (transcript.items.isEmpty()) {
                    item("empty") { Text("No messages yet.", color = colors.textMuted) }
                }
            }
            transcript.pendingApprovals.firstOrNull()?.let { approval ->
                ApprovalStrip(
                    approval = approval,
                    enabled = canApprove,
                    onDecide = { decision, feedback ->
                        viewModel.approve(session.id, approval.itemId, decision, feedback)
                    },
                    onOpenDetail = { approvalDetail = approval },
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
            attachment?.let { uri ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        uri.lastPathSegment ?: "Image attachment",
                        Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    IconButton(onClick = { attachment = null }) { Icon(Icons.Rounded.Close, "Remove attachment") }
                }
            }
            ChatComposer(
                text = message,
                onTextChange = { message = it },
                placeholder = composerPlaceholder(transcript.pendingApprovals),
                modelLabel = currentOption?.name ?: session.model,
                modelProvider = session.provider,
                effort = selection.effort,
                fastMode = selection.fastMode,
                accessMode = ACCESS_MODES[accessModeIndex % ACCESS_MODES.size],
                contextRing = transcript.contextRing,
                turnLive = transcript.turnLive,
                canSend = canSend,
                canAttach = canAttach,
                onAttach = { attachmentPicker.launch("image/*") },
                onOpenModelPicker = {
                    // Pull the host's stored model only now — see
                    // MainViewModel.ensureSessionModelLoaded.
                    viewModel.ensureSessionModelLoaded(session.id)
                    showModelPicker = true
                },
                onCycleAccessMode = { accessModeIndex += 1 },
                onSend = {
                    viewModel.sendChat(message, attachment)
                    message = ""
                    attachment = null
                },
                // Stop interrupts the live turn. A pending approval is declined
                // first, because an agent blocked on a prompt is not interruptible
                // until the prompt is resolved.
                onStop = {
                    val pending = session.pendingInputItemId
                    if (pending != null && canApprove) {
                        viewModel.approve(session.id, pending, ApprovalDecision.DECLINE)
                    }
                    if (canInterrupt) viewModel.interruptSession(session.id)
                },
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        if (unreadBelow > 0 || !atBottom.value) {
            Box(Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 92.dp)) {
                JumpToLatestPill(unread = unreadBelow, onClick = { unreadBelow = 0 })
            }
        }
    }

    if (showModelPicker) {
        // Deliberately a bare Dialog rather than an AlertDialog: the picker
        // brings its own header, search and close affordance, and Material's
        // alert container boxed it into a narrow column with a second layer of
        // padding around the already-padded sheet.
        AdeDialogSurface(onDismiss = { showModelPicker = false }) {
                ChatModelPicker(
                    options = options,
                    selection = selection,
                    favouriteIds = favouriteIds,
                    recentIds = recentIds,
                    enabled = canSetModel,
                    onSelect = { next ->
                        selection = next
                        // Every picker interaction (model, effort, fast mode) is a
                        // chat.updateSession — the host is the source of truth for
                        // the session's model, not this local state.
                        next.modelId?.let { modelId ->
                            if (canSetModel) {
                                viewModel.setSessionModel(session.id, modelId, next.effort, next.fastMode)
                            }
                        }
                    },
                    onToggleFavourite = viewModel::toggleModelFavourite,
                    onClose = { showModelPicker = false },
                )
        }
    }

    approvalDetail?.let { approval ->
        ApprovalDetailSheet(
            approval = approval,
            enabled = canApprove,
            onDecide = { decision, feedback ->
                viewModel.approve(session.id, approval.itemId, decision, feedback)
                approvalDetail = null
            },
            onDismiss = { approvalDetail = null },
        )
    }
}

/** Access-mode control values, cycled in place until the host exposes the real set. */
private val ACCESS_MODES = listOf("Default", "Plan", "Accept edits", "Full access")

@Composable
private fun ChatTimelineRow(item: ChatTimelineItem) {
    when (item) {
        is ChatTimelineItem.TurnStart -> TurnStartDivider(item)
        is ChatTimelineItem.UserMessage -> UserMessageRow(item)
        is ChatTimelineItem.AssistantMessage -> AssistantMessageRow(item)
        is ChatTimelineItem.ToolGroup -> ToolGroupRow(item)
        is ChatTimelineItem.FilesChanged -> FilesChangedRow(item)
        is ChatTimelineItem.Subagent -> SubagentCard(item)
        is ChatTimelineItem.Usage -> UsagePill(item.summary)
        is ChatTimelineItem.TurnEnd -> TurnEndDivider(item)
        is ChatTimelineItem.Notice -> NoticeRow(item)
    }
}

internal fun isUserVisibleChatEvent(event: JsonObject): Boolean {
    val type = (event.string("type") ?: event.string("kind")).orEmpty()
        .lowercase().replace('-', '_').replace(' ', '_')
    if (type in setOf(
            "activity", "status", "done", "usage", "token_usage", "codex_token_usage",
            "turn_start", "turn_started", "turn_complete", "turn_completed",
        )
    ) return false
    val payload = event["payload"] as? JsonObject
    val hasPatch = event.string("patch") != null || event.string("diff") != null ||
        payload?.string("patch") != null || payload?.string("diff") != null
    if (hasPatch || type.contains("tool") || type.contains("approval") || type.contains("permission")) return true
    val hasText = eventText(event) != null
    if (event.string("role") != null) return hasText
    return hasText && listOf("text", "message", "content", "output", "response", "delta", "assistant", "user")
        .any(type::contains)
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

private fun eventSummary(event: JsonObject): String {
    val payload = event["payload"] as? JsonObject
    return event.string("summary")
        ?: payload?.string("summary")
        ?: payload?.string("message")
        ?: event.string("toolName")
        ?: payload?.string("toolName")
        ?: "Event details"
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
    Column(Modifier.fillMaxSize().imePadding().navigationBarsPadding()) {
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
            // The explicit composer below is the reliable soft-keyboard input
            // path. Keep hardware-keyboard support on the terminal itself.
            showSoftKeyboard = false,
        )
        TerminalInputControls(viewModel::sendTerminalInput)
    }
}

internal data class TerminalQuickKey(val label: String, val sequence: String)

internal val terminalPrimaryKeys = listOf(
    TerminalQuickKey("esc", "\u001B"),
    TerminalQuickKey("tab", "\t"),
    TerminalQuickKey("shift tab", "\u001B[Z"),
    TerminalQuickKey("↑", "\u001B[A"),
    TerminalQuickKey("↓", "\u001B[B"),
    TerminalQuickKey("←", "\u001B[D"),
    TerminalQuickKey("→", "\u001B[C"),
    TerminalQuickKey("enter", "\r"),
    TerminalQuickKey("soft return", "\\\r"),
)

internal val terminalControlKeys = listOf(
    TerminalQuickKey("^C", "\u0003"),
    TerminalQuickKey("^D", "\u0004"),
    TerminalQuickKey("^Z", "\u001A"),
    TerminalQuickKey("^L", "\u000C"),
    TerminalQuickKey("^R", "\u0012"),
    TerminalQuickKey("^U", "\u0015"),
    TerminalQuickKey("^A", "\u0001"),
    TerminalQuickKey("^E", "\u0005"),
    TerminalQuickKey("^K", "\u000B"),
    TerminalQuickKey("|", "|"),
    TerminalQuickKey("~", "~"),
    TerminalQuickKey("/", "/"),
    TerminalQuickKey("-", "-"),
)

@Composable
private fun TerminalInputControls(onSend: (String) -> Unit) {
    var input by remember { mutableStateOf("") }
    val context = LocalContext.current
    val clipboard = remember(context) { context.getSystemService(android.content.ClipboardManager::class.java) }
    val focusManager = LocalFocusManager.current
    val keyScroll = rememberScrollState()
    val controlScroll = rememberScrollState()
    fun submit() {
        onSend(input + "\r")
        input = ""
    }

    Surface(color = Color(0xF2111214), shadowElevation = 10.dp) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(keyScroll),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                terminalPrimaryKeys.forEach { key -> TerminalKeyChip(key, onSend) }
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(controlScroll),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                terminalControlKeys.forEach { key -> TerminalKeyChip(key, onSend) }
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    placeholder = { Text("Type to send keystrokes") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                    trailingIcon = {
                        IconButton(onClick = ::submit) {
                            Icon(
                                Icons.AutoMirrored.Rounded.Send,
                                contentDescription = "Send input",
                                tint = Color.White.copy(alpha = 0.66f),
                            )
                        }
                    },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color(0xFFF4F4F5),
                        unfocusedTextColor = Color(0xFFF4F4F5),
                        focusedBorderColor = Color(0xFFA78BFA),
                        unfocusedBorderColor = Color.White.copy(alpha = 0.22f),
                        focusedPlaceholderColor = Color.White.copy(alpha = 0.44f),
                        unfocusedPlaceholderColor = Color.White.copy(alpha = 0.44f),
                        cursorColor = Color(0xFFA78BFA),
                    ),
                )
                // Same reasoning as [TerminalKeyChip]: fixed light-on-dark, not
                // theme colours, because the bar is always on the terminal.
                TextButton(onClick = {
                    clipboard.primaryClip?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)?.coerceToText(context)?.toString()?.let { input += it }
                }) {
                    Text("Paste", color = Color(0xFFC4B5FD), fontWeight = FontWeight.SemiBold)
                }
                TextButton(onClick = { focusManager.clearFocus() }) {
                    Text("Hide", color = Color.White.copy(alpha = 0.62f), fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/**
 * Terminal quick-key chip.
 *
 * Deliberately theme-independent. The control bar sits on the terminal's own
 * near-black surface in BOTH appearances, so a stock [OutlinedButton] — which
 * takes its outline and label from the active colour scheme — rendered as dark
 * grey on black in light mode and was effectively unreadable.
 */
@Composable
private fun TerminalKeyChip(key: TerminalQuickKey, onSend: (String) -> Unit) {
    val shape = RoundedCornerShape(9.dp)
    Box(
        Modifier.height(34.dp)
            .clip(shape)
            .background(Color.White.copy(alpha = 0.07f))
            .border(0.75.dp, Color.White.copy(alpha = 0.20f), shape)
            .pressableCard { onSend(key.sequence) }
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            key.label,
            color = Color(0xFFE6E6EA),
            fontSize = 13.sp,
            maxLines = 1,
            fontWeight = FontWeight.SemiBold,
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
    onSignIn: () -> Unit,
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

    if (showForget && machine != null) AdeDialog(
        title = "Forget ${machine.name}?",
        onDismiss = { showForget = false },
        icon = Icons.Rounded.Close,
        destructive = true,
        confirmLabel = "Forget",
        onConfirm = { viewModel.forget(machine.machineKey); showForget = false; onForgot() },
    ) {
        AdeDialogText("This deletes the paired secret and device key. Pair again to reconnect.")
    }
    if (showPushPrimer) AdeDialog(
        title = "Allow agent notifications?",
        onDismiss = { showPushPrimer = false },
        icon = Icons.Rounded.Notifications,
        dismissLabel = "Not now",
        confirmLabel = "Continue",
        onConfirm = {
            showPushPrimer = false
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        },
    ) {
        AdeDialogText("ADE will notify you only for approvals and attention events allowed by your settings. Every alert opens the relevant work, and you can turn it off here at any time.")
    }
    listRename?.let { target ->
        AdeDialog(
            title = "Rename ${target.name}",
            onDismiss = { listRename = null },
            icon = Icons.Rounded.Edit,
            confirmLabel = "Save",
            confirmEnabled = listRenameText.isNotBlank(),
            onConfirm = { viewModel.renameMachine(target.machineKey, listRenameText); listRename = null },
        ) {
            AdeTextField(listRenameText, { listRenameText = it.take(80) }, "Display name")
        }
    }

    val colors = AdeTokens.colors
    AdeScreen("Settings", onBack) {
        LazyColumn(
            // The destructive "Forget machine" button is the last row, so it must
            // not sit under the gesture bar.
            Modifier.fillMaxSize().navigationBarsPadding().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item { SettingsSectionLabel("ACCOUNT", top = 4.dp) }
            item {
                SettingsCard {
                    Text(
                        if (state.signedIn) "Signed in to ADE" else "Using ADE without an account",
                        color = colors.textPrimary,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (state.signedIn) {
                        state.accountName?.let {
                            Text(it, color = colors.textSecondary, style = MaterialTheme.typography.bodyMedium)
                        }
                        state.accountEmail?.takeIf { it != state.accountName }?.let {
                            Text(it, color = colors.textMuted, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Text(
                        if (state.signedIn) "Machine discovery and account attention are available."
                        else "Saved paired machines remain available over direct routes.",
                        color = colors.textMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    SettingsDivider()
                    if (state.signedIn) {
                        SettingsActionButton("Sign out", tint = colors.textSecondary) {
                            viewModel.signOut(); onSignedOut()
                        }
                    } else {
                        SettingsActionButton("Sign in", tint = colors.accent, filled = true, onClick = onSignIn)
                    }
                }
            }

            item { SettingsSectionLabel("CONNECTION") }
            item {
                SettingsCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusRing(connectionTint(status.state), hollow = status.state != "connected", size = 8)
                        Text(
                            machine?.name ?: "No machine",
                            Modifier.weight(1f),
                            color = colors.textPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.MiddleEllipsis,
                        )
                        AdeTintChip(
                            status.state,
                            connectionTint(status.state),
                            fillAlpha = 0.13f,
                            strokeAlpha = 0.28f,
                            horizontalPadding = 8,
                            verticalPadding = 3,
                        )
                    }
                    Text(
                        status.route?.name?.lowercase() ?: "no route",
                        color = colors.textMuted,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                    status.error?.let { SettingsInlineBanner(it) }
                    hello?.features?.mobileCompatibility?.takeIf { it.mode != "full" || it.missingActions.isNotEmpty() }?.let { compatibility ->
                        SettingsInlineBanner(
                            "This machine is missing ${compatibility.missingActions.size} Android actions. Update ADE for full controls.",
                            tint = colors.warning,
                        )
                    }
                    if (machine != null) {
                        SettingsDivider()
                        OutlinedTextField(
                            rename,
                            { rename = it.take(80) },
                            Modifier.fillMaxWidth(),
                            label = { Text("Display name") },
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = colors.accent,
                                unfocusedBorderColor = colors.border,
                                focusedLabelColor = colors.accent,
                                unfocusedLabelColor = colors.textMuted,
                                focusedTextColor = colors.textPrimary,
                                unfocusedTextColor = colors.textPrimary,
                            ),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SettingsActionButton(
                                "Save name",
                                tint = colors.accent,
                                modifier = Modifier.weight(1f),
                                enabled = rename.isNotBlank(),
                            ) { viewModel.renameMachine(machine.machineKey, rename) }
                            SettingsActionButton(
                                "Disconnect",
                                tint = colors.textSecondary,
                                modifier = Modifier.weight(1f),
                                enabled = status.state == "connected",
                                onClick = viewModel::disconnect,
                            )
                            SettingsActionButton(
                                "Reconnect",
                                tint = colors.accent,
                                filled = true,
                                modifier = Modifier.weight(1f),
                                enabled = status.state != "connecting",
                            ) { viewModel.connect(machine) }
                        }
                        if (status.state == "error") {
                            SettingsActionButton("Pair again with PIN", tint = colors.warning, onClick = onPair)
                        }
                    }
                }
            }

            item { SettingsSectionLabel("MACHINES") }
            items(machineItems, key = SettingsMachineItem::machineKey) { item ->
                val enabled = item.saved != null || item.directory?.reachableEndpoints?.isNotEmpty() == true
                val tint = when {
                    item.current -> colors.accent
                    item.online -> colors.success
                    else -> colors.textMuted
                }
                SettingsCard(
                    modifier = Modifier.combinedClickable(
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
                    padding = 12.dp,
                    spacing = 3.dp,
                    accent = if (item.current) colors.accent else null,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusRing(tint, hollow = !item.online && !item.current, size = 8)
                        Column(Modifier.weight(1f)) {
                            Text(
                                item.name,
                                color = colors.textPrimary,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.MiddleEllipsis,
                            )
                            Text(
                                when {
                                    item.current -> "Current machine"
                                    item.online -> "Online"
                                    item.saved != null -> "Offline · saved pairing"
                                    else -> "Offline"
                                },
                                color = colors.textMuted,
                                fontSize = 11.sp,
                            )
                        }
                        AdeTintChip(
                            if (enabled) "Connect" else "Unavailable",
                            if (enabled) colors.accent else colors.textMuted,
                            fillAlpha = if (enabled) 0.12f else 0f,
                            strokeAlpha = if (enabled) 0.28f else 0.28f,
                            horizontalPadding = 9,
                            verticalPadding = 4,
                        )
                    }
                }
            }
            item {
                SettingsActionButton("+ Add machine", tint = colors.accent, filled = true, onClick = onPair)
            }

            item { SettingsSectionLabel("APPEARANCE") }
            item {
                SettingsCard(padding = 4.dp, spacing = 0.dp) {
                    Appearance.entries.forEachIndexed { index, option ->
                        if (index > 0) SettingsDivider(inset = 12.dp)
                        val selected = option == appearance
                        Row(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .clickable { viewModel.setAppearance(option) }
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected,
                                { viewModel.setAppearance(option) },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = colors.accent,
                                    unselectedColor = colors.textMuted,
                                ),
                            )
                            Text(
                                option.name.lowercase().replaceFirstChar(Char::uppercase),
                                color = if (selected) colors.textPrimary else colors.textSecondary,
                                fontSize = 15.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }
            }

            item { SettingsSectionLabel("PRIVACY AND NOTIFICATIONS") }
            item {
                SettingsCard(spacing = 0.dp) {
                    SettingToggle(
                        "Product analytics",
                        "Allow privacy-bounded Android usage events through your connected ADE machine.",
                        analytics,
                        viewModel::setAnalyticsEnabled,
                    )
                    SettingsDivider()
                    SettingToggle("Push notifications", "Show approvals and agent attention on this device.", push) { enabled ->
                        if (!enabled) viewModel.setPushEnabled(false)
                        else if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                            viewModel.setPushEnabled(true)
                        } else showPushPrimer = true
                    }
                    if (state.signedIn) {
                        val attentionAccount = state.attentionPreferences?.get("account") as? JsonObject
                        SettingsDivider()
                        SettingToggle(
                            "Hide notification details",
                            "Use private notification text on the lock screen.",
                            attentionAccount.flag("hideDetails"),
                        ) { viewModel.setAttentionAccountFlag("hideDetails", it) }
                        SettingsDivider()
                        SettingToggle(
                            "Notification sounds",
                            "Play sound for allowed attention events.",
                            attentionAccount.flag("soundsEnabled"),
                        ) { viewModel.setAttentionAccountFlag("soundsEnabled", it) }
                        SettingsDivider()
                        SettingToggle(
                            "Desktop first",
                            "Delay phone alerts briefly while ADE is visible on the desktop.",
                            attentionAccount.flag("desktopFirstEnabled", default = true),
                        ) { viewModel.setAttentionAccountFlag("desktopFirstEnabled", it) }
                    }
                }
            }

            item { SettingsSectionLabel("AI USAGE") }
            item {
                UsageQuotaCard(state.quota, viewModel::refreshQuota)
            }

            item { SettingsSectionLabel("CONNECTION DETAILS") }
            item {
                SettingsCard(spacing = 0.dp) {
                    DetailLine("Route", status.route?.name?.lowercase() ?: "Not connected")
                    DetailLine("Machine key", machine?.machineKey?.take(12) ?: "—")
                    DetailLine("Device", machine?.pairedDeviceId ?: "—")
                    DetailLine("Host version", hello?.brain?.appVersion ?: "—")
                    DetailLine("App version", "${com.ade.android.BuildConfig.VERSION_NAME} (${com.ade.android.BuildConfig.VERSION_CODE})")
                }
            }

            if (machine != null) item {
                Box(
                    Modifier.fillMaxWidth()
                        .padding(top = 8.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.danger.copy(alpha = 0.10f))
                        .border(0.75.dp, colors.danger.copy(alpha = 0.30f), RoundedCornerShape(12.dp))
                        .pressableCard { showForget = true }
                        .padding(vertical = 11.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Icon(Icons.Rounded.Close, null, Modifier.size(15.dp), tint = colors.danger)
                        Text("Forget machine", color = colors.danger, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            item { Spacer(Modifier.height(28.dp)) }
        }
    }
}

@Composable
private fun connectionTint(state: String): Color {
    val colors = AdeTokens.colors
    return when (state) {
        "connected" -> colors.success
        "connecting" -> colors.warning
        "error" -> colors.danger
        else -> colors.textMuted
    }
}

/** Uppercase settings group label, matching the Lanes tab section label. */
@Composable
private fun SettingsSectionLabel(text: String, top: androidx.compose.ui.unit.Dp = 12.dp) {
    Box(Modifier.padding(start = 4.dp, top = top, bottom = 2.dp)) { LaneSectionLabel(text) }
}

/** Grouped settings container — same glass/border idiom as the Work and Lanes cards. */
@Composable
private fun SettingsCard(
    modifier: Modifier = Modifier,
    padding: androidx.compose.ui.unit.Dp = 14.dp,
    spacing: androidx.compose.ui.unit.Dp = 8.dp,
    accent: Color? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(accent?.copy(alpha = 0.10f) ?: colors.card.copy(alpha = if (colors.isDark) 0.70f else 0.86f))
            .border(0.75.dp, accent?.copy(alpha = 0.30f) ?: colors.glassBorder, shape)
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}

@Composable
private fun SettingsDivider(inset: androidx.compose.ui.unit.Dp = 0.dp) {
    HorizontalDivider(
        Modifier.padding(start = inset, top = 6.dp, bottom = 6.dp),
        thickness = 0.75.dp,
        color = AdeTokens.colors.border.copy(alpha = 0.55f),
    )
}

@Composable
private fun SettingsInlineBanner(message: String, tint: Color = AdeTokens.colors.danger) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = 0.12f))
            .border(0.75.dp, tint.copy(alpha = 0.28f), RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(message, color = tint, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun SettingsActionButton(
    label: String,
    tint: Color,
    modifier: Modifier = Modifier,
    filled: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                when {
                    filled && enabled -> tint
                    // Disabled filled buttons drop to the outlined treatment:
                    // `onAccent` on a 45%-alpha accent was dark-purple-on-purple.
                    filled -> tint.copy(alpha = 0.14f)
                    else -> colors.surface.copy(alpha = if (colors.isDark) 0.45f else 0.70f)
                },
            )
            .border(
                0.75.dp,
                if (filled && enabled) Color.White.copy(alpha = 0.18f) else tint.copy(alpha = 0.30f),
                shape,
            )
            .then(if (enabled) Modifier.pressableCard(onClick) else Modifier)
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = when {
                !enabled -> tint.copy(alpha = 0.45f)
                filled -> colors.onAccent
                else -> tint
            },
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
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
    val colors = AdeTokens.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = colors.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(detail, color = colors.textMuted, fontSize = 11.sp, lineHeight = 15.sp)
        }
        Spacer(Modifier.size(10.dp))
        Switch(
            checked,
            onChecked,
            colors = SwitchDefaults.colors(
                checkedThumbColor = colors.onAccent,
                checkedTrackColor = colors.accent,
                checkedBorderColor = colors.accent,
                uncheckedTrackColor = colors.surface,
                uncheckedBorderColor = colors.border,
                uncheckedThumbColor = colors.textMuted,
            ),
        )
    }
}

@Composable
private fun UsageQuotaCard(quota: JsonElement?, onRefresh: () -> Unit) {
    val source = quota as? JsonObject
    val windows = (source?.get("windows") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    val colors = AdeTokens.colors
    SettingsCard(spacing = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Live provider limits",
                Modifier.weight(1f),
                color = colors.textPrimary,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
            )
            AdeTintChip(
                "Refresh",
                colors.accent,
                Modifier.pressableCard(onRefresh),
                fillAlpha = 0.12f,
                strokeAlpha = 0.28f,
                horizontalPadding = 10,
                verticalPadding = 5,
            )
        }
        if (windows.isEmpty()) {
            Text("Quota data is unavailable on this machine.", color = colors.textMuted, fontSize = 12.sp)
        } else {
            windows.groupBy { it.string("provider") ?: "provider" }.forEach { (provider, providerWindows) ->
                Text(
                    provider.replaceFirstChar(Char::uppercase),
                    color = colors.textSecondary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.4.sp,
                )
                providerWindows.forEach { window ->
                    val percent = window["percentUsed"]?.jsonPrimitive?.doubleOrNull?.coerceIn(0.0, 100.0) ?: 0.0
                    val tint = when {
                        percent >= 90.0 -> colors.danger
                        percent >= 70.0 -> colors.warning
                        else -> colors.accent
                    }
                    Column(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                (window.string("windowType") ?: "limit").replace('_', ' ').replaceFirstChar(Char::uppercase),
                                Modifier.weight(1f),
                                color = colors.textSecondary,
                                fontSize = 13.sp,
                            )
                            Text(
                                "${"%.1f".format(percent)}%",
                                color = tint,
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        LinearProgressIndicator(
                            progress = { (percent / 100.0).toFloat() },
                            modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)),
                            color = tint,
                            trackColor = colors.recessed,
                            gapSize = 0.dp,
                            drawStopIndicator = {},
                        )
                        val resets = window["resetsInMs"]?.jsonPrimitive?.doubleOrNull?.toLong()
                        if (resets != null) Text(
                            "Resets in ${formatDuration(resets)}",
                            color = colors.textMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
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
    val colors = AdeTokens.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        // Both sides are weighted: an unbounded value (e.g. the ~45-char device
        // id) otherwise takes its full intrinsic width and squeezes the label to
        // zero, which makes the LABEL wrap mid-word instead of the value
        // ellipsizing.
        Text(
            label,
            Modifier.weight(1f),
            color = colors.textMuted,
            fontSize = 13.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            Modifier.weight(1.6f),
            color = colors.textSecondary,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            textAlign = TextAlign.End,
            overflow = TextOverflow.MiddleEllipsis,
        )
    }
}

private fun UiSession.isTerminal(): Boolean = kind == SessionKind.TERMINAL
private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
private fun JsonObject?.flag(key: String, default: Boolean = false): Boolean =
    this?.get(key)?.jsonPrimitive?.booleanOrNull ?: default

// ---------------------------------------------------------------------------
// Previews
//
// Settings is assembled from private primitives that are pure functions of their
// arguments, so every section can be previewed without a MainViewModel. The
// sample values are deliberately hostile: a long machine name, a full-length
// device id, and quota windows at each of the three tint thresholds — those are
// where this layout has broken before.
// ---------------------------------------------------------------------------

private val previewQuota: JsonElement = buildJsonObject {
    put("windows", buildJsonArray {
        add(buildJsonObject {
            put("provider", JsonPrimitive("codex"))
            put("windowType", JsonPrimitive("five_hour"))
            put("percentUsed", JsonPrimitive(24.0))
            put("resetsInMs", JsonPrimitive(7_200_000))
        })
        add(buildJsonObject {
            put("provider", JsonPrimitive("codex"))
            put("windowType", JsonPrimitive("weekly"))
            put("percentUsed", JsonPrimitive(76.4))
            put("resetsInMs", JsonPrimitive(320_400_000))
        })
        add(buildJsonObject {
            put("provider", JsonPrimitive("claude"))
            put("windowType", JsonPrimitive("weekly"))
            put("percentUsed", JsonPrimitive(93.2))
            put("resetsInMs", JsonPrimitive(90_000))
        })
    })
}

@Composable
private fun SettingsPreviewBody() {
    val colors = AdeTokens.colors
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SettingsSectionLabel("ACCOUNT", top = 0.dp)
        SettingsCard {
            Text("Signed in to ADE", color = colors.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text("Arul Sharma", color = colors.textSecondary, style = MaterialTheme.typography.bodyMedium)
            Text(
                "Machine discovery and account attention are available.",
                color = colors.textMuted,
                style = MaterialTheme.typography.bodySmall,
            )
            SettingsDivider()
            SettingsActionButton("Sign out", tint = colors.textSecondary) {}
        }

        SettingsSectionLabel("CONNECTION")
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusRing(colors.success, hollow = false, size = 8)
                Text(
                    "arul-desktop-workstation-primary",
                    Modifier.weight(1f),
                    color = colors.textPrimary,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
                AdeTintChip("connected", colors.success, fillAlpha = 0.13f, strokeAlpha = 0.28f, horizontalPadding = 8, verticalPadding = 3)
            }
            Text("lan", color = colors.textMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            SettingsInlineBanner("This machine is missing 3 Android actions. Update ADE for full controls.", tint = colors.warning)
            SettingsDivider()
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SettingsActionButton("Save name", tint = colors.accent, modifier = Modifier.weight(1f)) {}
                SettingsActionButton("Disconnect", tint = colors.textSecondary, modifier = Modifier.weight(1f), enabled = false) {}
                SettingsActionButton("Reconnect", tint = colors.accent, filled = true, modifier = Modifier.weight(1f)) {}
            }
        }

        SettingsSectionLabel("APPEARANCE")
        SettingsCard(padding = 4.dp, spacing = 0.dp) {
            Appearance.entries.forEachIndexed { index, option ->
                if (index > 0) SettingsDivider(inset = 12.dp)
                val selected = index == 0
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(
                        selected,
                        {},
                        colors = RadioButtonDefaults.colors(selectedColor = colors.accent, unselectedColor = colors.textMuted),
                    )
                    Text(
                        option.name.lowercase().replaceFirstChar(Char::uppercase),
                        color = if (selected) colors.textPrimary else colors.textSecondary,
                        fontSize = 15.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }

        SettingsSectionLabel("PRIVACY AND NOTIFICATIONS")
        SettingsCard(spacing = 0.dp) {
            SettingToggle(
                "Product analytics",
                "Allow privacy-bounded Android usage events through your connected ADE machine.",
                true,
            ) {}
            SettingsDivider()
            SettingToggle("Push notifications", "Show approvals and agent attention on this device.", false) {}
            SettingsDivider()
            SettingToggle("Desktop first", "Delay phone alerts briefly while ADE is visible on the desktop.", true) {}
        }

        SettingsSectionLabel("AI USAGE")
        UsageQuotaCard(previewQuota) {}

        SettingsSectionLabel("CONNECTION DETAILS")
        SettingsCard(spacing = 0.dp) {
            DetailLine("Route", "lan")
            DetailLine("Machine key", "b31f9a02cc41")
            // The real device id is ~45 characters — the case that used to wrap
            // the LABEL instead of ellipsizing the value.
            DetailLine("Device", "device_01JQ7Z3M8K5R2XW9NPCV4TBHFA6YQ2LDS")
            DetailLine("App version", "1.2.47 (10247)")
        }

        Box(
            Modifier.fillMaxWidth()
                .padding(top = 8.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.danger.copy(alpha = 0.10f))
                .border(0.75.dp, colors.danger.copy(alpha = 0.30f), RoundedCornerShape(12.dp))
                .padding(vertical = 11.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Icons.Rounded.Close, null, Modifier.size(15.dp), tint = colors.danger)
                Text("Forget machine", color = colors.danger, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Preview(name = "Settings dark", showBackground = true, backgroundColor = 0xFF0C0B10, heightDp = 1700)
@Composable
private fun PreviewSettingsDark() = AdeTheme(dark = true) { SettingsPreviewBody() }

@Preview(name = "Settings light", showBackground = true, backgroundColor = 0xFFF5F3F0, heightDp = 1700)
@Composable
private fun PreviewSettingsLight() = AdeTheme(dark = false) { SettingsPreviewBody() }

/** Machine rows: current, online, and an unreachable directory-only entry. */
@Composable
private fun SettingsMachineRowsPreview() {
    val colors = AdeTokens.colors
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingsSectionLabel("MACHINES", top = 0.dp)
        listOf(
            Triple("arul-desktop-workstation-primary-lan", "Current machine", colors.accent),
            Triple("mac-studio", "Online", colors.success),
            Triple("thinkpad-x1-carbon-gen-11-travel", "Offline · saved pairing", colors.textMuted),
        ).forEachIndexed { index, row ->
            val (name, subtitle, tint) = row
            SettingsCard(padding = 12.dp, spacing = 3.dp, accent = if (index == 0) colors.accent else null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusRing(tint, hollow = index == 2, size = 8)
                    Column(Modifier.weight(1f)) {
                        Text(
                            name,
                            color = colors.textPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.MiddleEllipsis,
                        )
                        Text(subtitle, color = colors.textMuted, fontSize = 11.sp)
                    }
                    AdeTintChip(
                        if (index == 2) "Unavailable" else "Connect",
                        if (index == 2) colors.textMuted else colors.accent,
                        fillAlpha = if (index == 2) 0f else 0.12f,
                        strokeAlpha = 0.28f,
                        horizontalPadding = 9,
                        verticalPadding = 4,
                    )
                }
            }
        }
        SettingsActionButton("+ Add machine", tint = colors.accent, filled = true) {}
    }
}

@Preview(name = "Settings machines dark", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewSettingsMachinesDark() = AdeTheme(dark = true) { SettingsMachineRowsPreview() }

@Preview(name = "Settings machines light", showBackground = true, backgroundColor = 0xFFF5F3F0)
@Composable
private fun PreviewSettingsMachinesLight() = AdeTheme(dark = false) { SettingsMachineRowsPreview() }

/** No-machine / no-quota empty states. */
@Composable
private fun SettingsEmptyPreviewBody() {
    val colors = AdeTokens.colors
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingsSectionLabel("CONNECTION", top = 0.dp)
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusRing(colors.textMuted, hollow = true, size = 8)
                Text("No machine", Modifier.weight(1f), color = colors.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                AdeTintChip("idle", colors.textMuted, fillAlpha = 0.13f, strokeAlpha = 0.28f, horizontalPadding = 8, verticalPadding = 3)
            }
            Text("no route", color = colors.textMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            SettingsInlineBanner("Could not reach the machine over any route.")
        }
        SettingsSectionLabel("MACHINES")
        SettingsActionButton("+ Add machine", tint = colors.accent, filled = true) {}
        SettingsSectionLabel("AI USAGE")
        UsageQuotaCard(null) {}
    }
}

@Preview(name = "Settings empty dark", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewSettingsEmptyDark() = AdeTheme(dark = true) { SettingsEmptyPreviewBody() }

@Preview(name = "Settings empty light", showBackground = true, backgroundColor = 0xFFF5F3F0)
@Composable
private fun PreviewSettingsEmptyLight() = AdeTheme(dark = false) { SettingsEmptyPreviewBody() }

/**
 * The Settings dialogs. `Dialog` does not render inside `@Preview`, so this
 * previews [AdeDialogCard] — the card body that [AdeDialog] wraps in a window.
 */
@Composable
private fun SettingsDialogPreviewBody() {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AdeDialogCard(
            title = "Forget arul-desktop-workstation-primary?",
            icon = Icons.Rounded.Close,
            destructive = true,
            confirmLabel = "Forget",
        ) {
            AdeDialogText("This deletes the paired secret and device key. Pair again to reconnect.")
        }
        AdeDialogCard(
            title = "Allow agent notifications?",
            icon = Icons.Rounded.Notifications,
            confirmLabel = "Continue",
            dismissLabel = "Not now",
        ) {
            AdeDialogText("ADE will notify you only for approvals and attention events allowed by your settings. Every alert opens the relevant work, and you can turn it off here at any time.")
        }
        AdeDialogCard(title = "Rename mac-studio", icon = Icons.Rounded.Edit, confirmLabel = "Save") {
            AdeTextField("mac-studio", {}, "Display name")
        }
        AdeDialogCard(title = "Rename mac-studio", icon = Icons.Rounded.Edit, confirmLabel = "Save", confirmEnabled = false) {
            AdeTextField("", {}, "Display name")
        }
    }
}

@Preview(name = "Settings dialogs dark", showBackground = true, backgroundColor = 0xFF0C0B10, heightDp = 900)
@Composable
private fun PreviewSettingsDialogsDark() = AdeTheme(dark = true) { SettingsDialogPreviewBody() }

@Preview(name = "Settings dialogs light", showBackground = true, backgroundColor = 0xFFF5F3F0, heightDp = 900)
@Composable
private fun PreviewSettingsDialogsLight() = AdeTheme(dark = false) { SettingsDialogPreviewBody() }
