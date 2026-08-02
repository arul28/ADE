package com.ade.android.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Chat transcript surfaces, ported from the iOS spec:
 *   - WorkChatHeaderAndMessageViews.swift (messages, dividers)
 *   - WorkChatRichCardViews.swift (tool calls, file changes, subagents)
 *   - WorkChatComposerAndInputViews.swift (usage pill)
 *
 * All colours come from [AdeTokens] — `accent` is GREEN in light mode and
 * purple only in dark, so nothing here may hardcode a hue.
 */

private val MONO = FontFamily.Monospace

/** Packed ARGB long (from ChatPresentation) to a Compose colour. */
internal fun argbColor(value: Long): Color = Color(
    red = ((value ushr 16) and 0xFF).toInt(),
    green = ((value ushr 8) and 0xFF).toInt(),
    blue = (value and 0xFF).toInt(),
    alpha = ((value ushr 24) and 0xFF).toInt(),
)

private val TIME_FORMAT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(ZoneId.systemDefault())

internal fun formatClockTime(iso: String?): String? =
    runCatching { iso?.let { TIME_FORMAT.format(Instant.parse(it)) } }.getOrNull()

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The assistant answer: plain flowing markdown on the flat canvas. No bubble,
 * no card, no border — deliberately. Truncation steps by 48 lines per tap.
 */
@Composable
internal fun AssistantMessageRow(item: ChatTimelineItem.AssistantMessage, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    var lineBudget by remember(item.id) { mutableStateOf(ASSISTANT_INITIAL_LINE_BUDGET) }
    val streamingParser = remember(item.id) { StreamingMarkdownParser() }
    val preview = remember(item.text, lineBudget) { assistantMessagePreview(item.text, lineBudget) }
    val blocks = remember(preview.text, item.streaming) {
        if (item.streaming) streamingParser.parse(preview.text) else parseMarkdownBlocks(preview.text)
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        MarkdownBody(preview.text, preview.usesMonospacedRendering, blocks)
        if (preview.truncated) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    assistantPreviewSummary(preview),
                    fontSize = 11.sp,
                    color = colors.textMuted,
                )
                Text(
                    "Copy full",
                    Modifier.clickable { }.padding(vertical = 2.dp),
                    fontSize = 11.sp,
                    color = colors.textSecondary,
                )
                Text(
                    "Show more",
                    Modifier
                        .clickable { lineBudget += ASSISTANT_LINE_BUDGET_STEP }
                        .padding(vertical = 2.dp),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.accent,
                )
            }
        }
    }
}

/** Right-aligned terracotta bubble. The fill is COMPUTED per provider. */
@Composable
internal fun UserMessageRow(item: ChatTimelineItem.UserMessage, modifier: Modifier = Modifier) {
    val viewportWidth = LocalConfiguration.current.screenWidthDp
    val maxWidth = ((viewportWidth - 32) * 0.92f).dp
    val fill = argbColor(userBubbleFillArgb(item.provider, item.modelId))
    val border = argbColor(userBubbleBorderArgb(item.provider, item.modelId))
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            Modifier
                .widthIn(max = maxWidth)
                .background(fill, RoundedCornerShape(16.dp))
                .border(0.8.dp, border, RoundedCornerShape(16.dp))
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Text(item.text, fontSize = 17.sp, lineHeight = 22.sp, color = Color.White)
        }
    }
}

// ---------------------------------------------------------------------------
// Disclosures — tool calls and files changed
// ---------------------------------------------------------------------------

@Composable
private fun DisclosureChevron(expanded: Boolean) {
    val colors = AdeTokens.colors
    Text(
        "›",
        Modifier.rotate(if (expanded) 90f else 0f).width(9.dp),
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = colors.textMuted.copy(alpha = 0.65f),
    )
}

/** A 7dp purple dot with a 2dp @35% ring — the running marker. */
@Composable
private fun RunningDot(animated: Boolean = true) {
    val colors = AdeTokens.colors
    val alpha = if (!animated) 1f else {
        val transition = rememberInfiniteTransition(label = "running")
        transition.animateFloat(
            initialValue = 0.45f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(760), RepeatMode.Reverse),
            label = "runningAlpha",
        ).value
    }
    Box(Modifier.size(11.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(11.dp)
                .border(2.dp, colors.accentDeep.copy(alpha = 0.35f), CircleShape),
        )
        Box(Modifier.size(7.dp).background(colors.accentDeep.copy(alpha = alpha), CircleShape))
    }
}

@Composable
private fun ToolStatusGlyph(status: ToolCallStatus) {
    val colors = AdeTokens.colors
    when (status) {
        ToolCallStatus.COMPLETED -> Text("✓", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = colors.success)
        ToolCallStatus.FAILED -> Text("✕", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = colors.danger)
        ToolCallStatus.RUNNING -> RunningDot()
    }
}

@Composable
internal fun ToolGroupRow(item: ChatTimelineItem.ToolGroup, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    var expanded by remember(item.id) { mutableStateOf(false) }
    val last = item.calls.lastOrNull()
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            DisclosureChevron(expanded)
            Text("Tool calls", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = colors.textMuted)
            Text(
                "(${item.calls.size})",
                fontSize = 11.sp,
                fontFamily = MONO,
                color = colors.textMuted.copy(alpha = 0.55f),
            )
            last?.let { ToolStatusGlyph(it.status) }
            last?.let {
                Text(
                    it.slug,
                    fontSize = 11.sp,
                    fontFamily = MONO,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textMuted,
                )
            }
            last?.target?.let {
                Text(
                    it,
                    fontSize = 12.sp,
                    color = colors.textPrimary.copy(alpha = 0.88f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (expanded) {
            Column(
                Modifier.fillMaxWidth().padding(start = 16.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                item.calls.forEach { call -> ToolCallRow(call) }
            }
        }
    }
}

@Composable
private fun ToolCallRow(call: ChatToolCall) {
    val colors = AdeTokens.colors
    var expanded by remember(call.itemId) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ToolStatusGlyph(call.status)
            Text(
                call.slug,
                fontSize = 11.sp,
                fontFamily = MONO,
                fontWeight = FontWeight.SemiBold,
                color = colors.textMuted,
            )
            Text(
                call.target.orEmpty(),
                fontSize = 12.sp,
                color = colors.textPrimary.copy(alpha = 0.88f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded && !call.detail.isNullOrBlank()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .background(colors.recessed.copy(alpha = 0.85f), RoundedCornerShape(10.dp))
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .padding(8.dp),
            ) {
                Text(
                    call.detail,
                    fontFamily = MONO,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                    color = colors.textSecondary,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
internal fun FilesChangedRow(item: ChatTimelineItem.FilesChanged, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    var expanded by remember(item.id) { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            DisclosureChevron(expanded)
            Text("Files changed", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = colors.textMuted)
            Text(
                "(${item.files.size})",
                fontSize = 11.sp,
                fontFamily = MONO,
                color = colors.textMuted.copy(alpha = 0.55f),
            )
            RunningDot(animated = false)
            Text(
                "+${item.additions}",
                fontSize = 11.sp,
                fontFamily = MONO,
                color = colors.success.copy(alpha = 0.85f),
            )
            Text(
                "−${item.deletions}",
                fontSize = 11.sp,
                fontFamily = MONO,
                color = colors.danger.copy(alpha = 0.85f),
            )
            item.files.lastOrNull()?.let {
                Text(
                    middleTruncate(it.path),
                    fontSize = 12.sp,
                    fontFamily = MONO,
                    color = colors.textPrimary.copy(alpha = 0.88f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (expanded) {
            Column(
                Modifier.fillMaxWidth().padding(start = 16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item.files.forEach { file -> FileChangeRow(file) }
            }
        }
    }
}

@Composable
private fun FileChangeRow(file: ChatFileChange) {
    val colors = AdeTokens.colors
    var expanded by remember(file.itemId) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                file.extension.ifEmpty { "•" },
                Modifier
                    .border(0.75.dp, colors.glassBorder, RoundedCornerShape(3.dp))
                    .padding(horizontal = 3.dp, vertical = 1.dp),
                fontSize = 9.sp,
                fontFamily = MONO,
                fontWeight = FontWeight.Black,
                letterSpacing = 0.4.sp,
                color = colors.textMuted,
            )
            Text(
                middleTruncate(file.path, 38),
                Modifier.weight(1f, fill = false),
                fontSize = 12.sp,
                fontFamily = MONO,
                color = colors.textSecondary,
                maxLines = 1,
            )
            fileChangeKindLabel(file.kind)?.let {
                Text(it, fontSize = 11.sp, color = colors.textMuted)
            }
            Text("+${file.additions}", fontSize = 11.sp, fontFamily = MONO, color = colors.success)
            Text("−${file.deletions}", fontSize = 11.sp, fontFamily = MONO, color = colors.danger)
        }
        if (expanded && file.diff.isNotBlank()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .background(colors.recessed.copy(alpha = 0.85f), RoundedCornerShape(10.dp))
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .padding(8.dp),
            ) {
                Column {
                    file.diff.split("\n").forEach { line ->
                        Text(
                            line,
                            fontFamily = MONO,
                            fontSize = 11.sp,
                            lineHeight = 15.sp,
                            softWrap = false,
                            color = when (diffLineTone(line)) {
                                DiffLineTone.ADDITION -> colors.success.copy(alpha = 0.90f)
                                DiffLineTone.DELETION -> colors.danger.copy(alpha = 0.90f)
                                DiffLineTone.HUNK -> colors.accentDeep.copy(alpha = 0.80f)
                                DiffLineTone.CONTEXT -> colors.textSecondary
                            },
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Subagent card
// ---------------------------------------------------------------------------

@Composable
internal fun SubagentCard(item: ChatTimelineItem.Subagent, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    val snapshot = item.snapshot
    val tint = subagentTint(snapshot.status)
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.glass, RoundedCornerShape(12.dp))
            .border(0.8.dp, tint.copy(alpha = 0.16f), RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SubagentIdenticon(snapshot.agentId)
            Text(
                snapshot.name,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            snapshot.agentType?.let { type ->
                Text(
                    type,
                    Modifier
                        .background(colors.surface.copy(alpha = 0.55f), CircleShape)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                    fontSize = 10.sp,
                    color = colors.textMuted,
                )
            }
            Spacer(Modifier.weight(1f))
            StatusChip(subagentStatusLabel(snapshot.status), tint)
        }
        Text(
            listOfNotNull(subagentStatusLabel(snapshot.status), snapshot.durationLabel).joinToString(" · "),
            fontSize = 11.sp,
            color = colors.textMuted,
        )
        snapshot.summary?.let { summary ->
            Text(
                summary,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = if (snapshot.status == SubagentStatus.FAILED) colors.danger else colors.textSecondary,
            )
        }
    }
}

@Composable
private fun subagentTint(status: SubagentStatus): Color {
    val colors = AdeTokens.colors
    return when (status) {
        SubagentStatus.RUNNING -> colors.accent
        SubagentStatus.SUCCEEDED -> colors.success
        SubagentStatus.FAILED -> colors.danger
        SubagentStatus.STOPPED -> colors.warning
    }
}

@Composable
internal fun StatusChip(label: String, tint: Color) {
    Text(
        label,
        Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(0.75.dp, tint.copy(alpha = 0.28f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        color = tint,
        maxLines = 1,
    )
}

/** Deterministic 3x3 bit grid seeded by djb2(agentId). */
@Composable
internal fun SubagentIdenticon(agentId: String, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    val palette = listOf(colors.accent, colors.success, colors.warning, colors.info, colors.danger)
    val color = palette[subagentGlyphColorIndex(agentId, palette.size)]
    Box(
        modifier
            .size(28.dp)
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(7.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            repeat(3) { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                    repeat(3) { column ->
                        val on = subagentGlyphBit(agentId, row * 3 + column)
                        Box(
                            Modifier
                                .size(5.dp)
                                .background(
                                    if (on) color else color.copy(alpha = 0.22f),
                                    RoundedCornerShape(1.5.dp),
                                ),
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Usage pill
// ---------------------------------------------------------------------------

@Composable
internal fun UsagePill(summary: ChatUsageSummary, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.surface.copy(alpha = 0.55f), CircleShape)
            .border(0.6.dp, colors.border.copy(alpha = 0.28f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "USAGE",
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            color = colors.textMuted,
        )
        Spacer(Modifier.weight(1f))
        UsageValue("In ${abbreviateCount(summary.inputTokens)}")
        UsageValue("Out ${abbreviateCount(summary.outputTokens)}")
        if (summary.cacheReadTokens > 0) UsageValue("Cache ${abbreviateCount(summary.cacheReadTokens)}")
        if (summary.cacheCreationTokens > 0) UsageValue("New cache ${abbreviateCount(summary.cacheCreationTokens)}")
        if (summary.costUsd > 0) {
            Text(formatUsageCost(summary.costUsd), fontSize = 10.sp, color = colors.textSecondary)
        }
    }
}

@Composable
private fun UsageValue(text: String) {
    Text(text, fontSize = 10.sp, color = AdeTokens.colors.textMuted, maxLines = 1)
}

// ---------------------------------------------------------------------------
// Turn dividers
// ---------------------------------------------------------------------------

@Composable
internal fun TurnStartDivider(item: ChatTimelineItem.TurnStart, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    Row(
        modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Hairline(Modifier.weight(1f))
        if (providerLogoRes(item.provider) != null) {
            ProviderMark(item.provider, 13.dp)
        } else {
            Box(Modifier.size(5.dp).background(colors.accent.copy(alpha = 0.70f), CircleShape))
        }
        Text(
            formatClockTime(item.timestampIso).orEmpty(),
            fontSize = 10.sp,
            color = colors.textMuted,
        )
        Hairline(Modifier.weight(1f))
    }
}

@Composable
internal fun TurnEndDivider(
    item: ChatTimelineItem.TurnEnd,
    onOpenTools: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    val label = listOfNotNull(
        formatClockTime(item.timestampIso),
        item.durationMs?.let { "Ran for ${formatShortDuration(it)}" },
    ).joinToString(" · ")
    Row(
        modifier
            .fillMaxWidth()
            .then(if (item.hadTools && onOpenTools != null) Modifier.clickable(onClick = onOpenTools) else Modifier)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Hairline(Modifier.weight(1f))
        Text(label.ifEmpty { "Turn complete" }, fontSize = 10.sp, color = colors.textMuted)
        if (item.hadTools) {
            Text("›", Modifier.width(8.dp), fontSize = 12.sp, color = colors.textMuted)
        }
        Hairline(Modifier.weight(1f))
    }
}

@Composable
private fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.height(0.6.dp).background(AdeTokens.colors.glassBorder))
}

@Composable
internal fun NoticeRow(item: ChatTimelineItem.Notice, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    Text(
        item.message,
        modifier
            .fillMaxWidth()
            .background(
                (if (item.failure) colors.danger else colors.textMuted).copy(alpha = 0.08f),
                RoundedCornerShape(10.dp),
            )
            .padding(10.dp),
        fontSize = 12.sp,
        color = if (item.failure) colors.danger else colors.textSecondary,
    )
}

// ---------------------------------------------------------------------------
// Approval strip
// ---------------------------------------------------------------------------

/**
 * Pinned above the composer — deliberately NOT part of the transcript.
 * Plan approvals swap Accept/Decline for Approve/Reject and expand an inline
 * feedback field before rejecting.
 */
@Composable
internal fun ApprovalStrip(
    approval: ChatApproval,
    enabled: Boolean,
    onDecide: (ApprovalDecision, String?) -> Unit,
    onOpenDetail: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    val accent = colors.accent
    var feedback by remember(approval.itemId) { mutableStateOf("") }
    var feedbackOpen by remember(approval.itemId) { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.card.copy(alpha = 0.76f), RoundedCornerShape(14.dp))
            .border(1.dp, accent.copy(alpha = 0.22f), RoundedCornerShape(14.dp)),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(2.dp)
                .background(
                    Brush.horizontalGradient(
                        listOf(accent.copy(alpha = 0.55f), accent.copy(alpha = 0.05f)),
                    ),
                ),
        )
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpenDetail).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.size(16.dp).background(accent.copy(alpha = 0.75f), CircleShape))
            Column(Modifier.weight(1f)) {
                Text(
                    "${providerShortLabel(approval.provider, com.ade.android.SessionKind.CHAT)} · Approval",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = accent,
                )
                Text(
                    approval.description,
                    fontSize = 10.sp,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text("⌃", fontSize = 13.sp, color = colors.textMuted)
        }
        // Plan rejections carry feedback: the first tap on Reject opens the field,
        // the second sends it as the host's `responseText`.
        if (approval.plan && feedbackOpen) {
            ApprovalFeedbackField(
                value = feedback,
                onValueChange = { feedback = it },
                modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 8.dp),
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                if (approval.plan) "Approve" else "Accept",
                Modifier
                    .weight(1f)
                    .background(colors.success.copy(alpha = if (enabled) 0.86f else 0.30f), CircleShape)
                    .clickable(enabled = enabled) { onDecide(ApprovalDecision.ACCEPT, null) }
                    .padding(vertical = 9.dp),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                color = Color.White,
            )
            Text(
                when {
                    !approval.plan -> "Decline"
                    feedbackOpen -> "Send rejection"
                    else -> "Reject"
                },
                Modifier
                    .weight(1f)
                    .background(colors.danger.copy(alpha = 0.08f), CircleShape)
                    .clickable(enabled = enabled) {
                        if (approval.plan && !feedbackOpen) {
                            feedbackOpen = true
                        } else {
                            onDecide(ApprovalDecision.DECLINE, feedback.takeIf { it.isNotBlank() })
                        }
                    }
                    .padding(vertical = 9.dp),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                color = colors.danger,
            )
        }
    }
}

@Composable
private fun ApprovalFeedbackField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    Box(
        modifier
            .fillMaxWidth()
            .background(colors.recessed.copy(alpha = 0.55f), RoundedCornerShape(10.dp))
            .border(0.5.dp, colors.glassBorder, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 9.dp),
    ) {
        if (value.isEmpty()) {
            Text("What should change? (optional)", fontSize = 12.sp, color = colors.textMuted)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            textStyle = TextStyle(fontSize = 12.sp, color = colors.textPrimary),
            cursorBrush = SolidColor(colors.accent),
        )
    }
}

/**
 * Expanded approval sheet. Adds the session-scoped grant ("Accept all for
 * session" → the host's `accept_for_session` decision) that the pinned strip has
 * no room for, and the same plan-rejection feedback field.
 */
@Composable
internal fun ApprovalDetailSheet(
    approval: ChatApproval,
    enabled: Boolean,
    onDecide: (ApprovalDecision, String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = AdeTokens.colors
    var feedback by remember(approval.itemId) { mutableStateOf("") }
    AdeDialogSurface(onDismiss = onDismiss) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(6.dp)) {
                Text(
                    "${providerShortLabel(approval.provider, com.ade.android.SessionKind.CHAT)} · " +
                        if (approval.plan) "Plan review" else "Approval",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.textPrimary,
                )
                Text(approval.description, fontSize = 13.sp, color = colors.textSecondary)
                ApprovalFeedbackField(value = feedback, onValueChange = { feedback = it })
                ApprovalSheetButton(
                    label = if (approval.plan) "Approve" else "Accept",
                    tint = colors.success,
                    enabled = enabled,
                ) { onDecide(ApprovalDecision.ACCEPT, feedback.takeIf { it.isNotBlank() }) }
                ApprovalSheetButton(
                    label = "Accept all for session",
                    tint = colors.accent,
                    enabled = enabled,
                ) { onDecide(ApprovalDecision.ACCEPT_FOR_SESSION, feedback.takeIf { it.isNotBlank() }) }
                ApprovalSheetButton(
                    label = if (approval.plan) "Reject" else "Decline",
                    tint = colors.danger,
                    enabled = enabled,
                ) { onDecide(ApprovalDecision.DECLINE, feedback.takeIf { it.isNotBlank() }) }
            }
    }
}

@Composable
private fun ApprovalSheetButton(label: String, tint: Color, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = if (enabled) 0.16f else 0.06f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.32f), CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 10.dp),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        color = tint,
    )
}

// ---------------------------------------------------------------------------
// Jump-to-latest, load-earlier
// ---------------------------------------------------------------------------

@Composable
internal fun JumpToLatestPill(unread: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    Row(
        modifier
            .background(colors.accent, CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text("↓", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = colors.onAccent)
        Text(
            if (unread > 0) "$unread new" else "Latest",
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.onAccent,
        )
    }
}

/**
 * Deliberate Android improvement: iOS auto-loads earlier history from an
 * invisible scroll sentinel; Android shows an explicit button instead. The
 * spinner and error states are kept.
 */
@Composable
internal fun LoadEarlierRow(
    count: Int?,
    loading: Boolean,
    error: Boolean,
    onLoad: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    val label = when {
        loading -> "Loading earlier messages…"
        error -> "Couldn't load earlier messages · Retry"
        count != null -> "Load $count earlier messages"
        else -> "Load earlier messages"
    }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .border(0.6.dp, colors.glassBorder, RoundedCornerShape(12.dp))
            .clickable(enabled = !loading, onClick = onLoad)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (!loading) {
            Text("⌃", fontSize = 13.sp, color = colors.accent)
            Spacer(Modifier.width(6.dp))
        }
        Text(
            label,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = if (error) colors.accent else colors.accent,
        )
    }
}
