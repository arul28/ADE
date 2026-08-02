package com.ade.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ade.android.SessionKind

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

internal fun Long.toComposeColor(): Color = Color(this.toInt())

/** iOS press feedback: scale 0.97 + opacity 0.85, snappy. */
@Composable
internal fun Modifier.pressFeedback(interaction: MutableInteractionSource): Modifier {
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, tween(200), label = "press-scale")
    val alpha by animateFloatAsState(if (pressed) 0.85f else 1f, tween(200), label = "press-alpha")
    return this.scale(scale).alpha(alpha)
}

@Composable
internal fun Modifier.pressableCard(onClick: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return this
        .pressFeedback(interaction)
        .clickable(interactionSource = interaction, indication = null, onClick = onClick)
}

/** Small capsule chip used across both tabs. */
@Composable
internal fun AdeTintChip(
    text: String,
    tint: Color,
    modifier: Modifier = Modifier,
    fillAlpha: Float = 0.10f,
    strokeAlpha: Float = 0f,
    leading: (@Composable () -> Unit)? = null,
    monospace: Boolean = false,
    horizontalPadding: Int = 6,
    verticalPadding: Int = 3,
) {
    Row(
        modifier
            .clip(CircleShape)
            .background(tint.copy(alpha = fillAlpha))
            .then(if (strokeAlpha > 0f) Modifier.border(0.75.dp, tint.copy(alpha = strokeAlpha), CircleShape) else Modifier)
            .padding(horizontal = horizontalPadding.dp, vertical = verticalPadding.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        leading?.invoke()
        Text(
            text,
            color = tint,
            fontSize = 11.sp,
            lineHeight = 13.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.SansSerif,
            maxLines = 1,
        )
    }
}

@Composable
internal fun StatusRing(tint: Color, hollow: Boolean, size: Int = 6) {
    if (hollow) {
        Box(
            Modifier.size(size.dp)
                .border(1.dp, AdeTokens.colors.textPrimary.copy(alpha = 0.35f), CircleShape),
        )
    } else {
        Box(Modifier.size(size.dp).background(tint, CircleShape))
    }
}

@Composable
internal fun rowTintColor(tint: WorkRowTint): Color = when (tint) {
    WorkRowTint.MUTED -> AdeTokens.colors.textMuted
    WorkRowTint.WARNING -> AdeTokens.colors.warning
    WorkRowTint.SUCCESS -> AdeTokens.colors.success
    WorkRowTint.SECONDARY -> AdeTokens.colors.textSecondary
}

// ---------------------------------------------------------------------------
// Provider mark
// ---------------------------------------------------------------------------

/**
 * 32dp provider tile. Renders the branded artwork ported from the iOS
 * `Provider*.imageset` assets when the provider has one; providers without an
 * asset keep the tinted-initial fallback.
 */
@Composable
internal fun ProviderTile(provider: String?, kind: SessionKind, tint: Color, size: Int = 32) {
    val logo = providerLogoRes(provider)
    Box(
        Modifier.size(size.dp)
            .clip(RoundedCornerShape((size / 3).dp))
            .background(tint.copy(alpha = 0.18f))
            .border(0.75.dp, tint.copy(alpha = 0.34f), RoundedCornerShape((size / 3).dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (logo != null) {
            androidx.compose.foundation.Image(
                painter = androidx.compose.ui.res.painterResource(logo),
                contentDescription = providerShortLabel(provider, kind),
                modifier = Modifier.size((size * 0.62f).dp),
            )
            return@Box
        }
        Text(
            providerGlyph(provider, kind),
            color = tint,
            fontSize = if (providerGlyph(provider, kind).length > 1) 11.sp else 14.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = if (kind == SessionKind.TERMINAL) FontFamily.Monospace else FontFamily.SansSerif,
        )
    }
}

// ---------------------------------------------------------------------------
// Session card — WorkRootComponents.swift:1259-1414
// ---------------------------------------------------------------------------

@Composable
internal fun WorkSessionCard(card: WorkCardModel, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    val providerTint = card.providerTintArgb.toComposeColor()
    val tint = rowTintColor(card.rowTint)
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (card.settled) 0.7f else 1f)
            .pressableCard(onClick)
            .clip(shape)
            .background(providerTint.copy(alpha = 0.12f))
            .border(0.75.dp, providerTint.copy(alpha = 0.25f), shape)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ProviderTile(card.provider, card.kind, providerTint)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                StatusRing(tint, hollow = card.settled)
                Text(
                    card.title,
                    // A single weighted child. This was `weight(1f, fill = false)`
                    // followed by a `Spacer(weight(1f))`, which split the free
                    // width evenly between the title and the spacer — so
                    // "Windows-Codex-smoke" ellipsized to "Windows-Cod…" with
                    // half the row sitting empty.
                    Modifier.weight(1f),
                    color = colors.textPrimary,
                    fontSize = 15.sp,
                    lineHeight = 19.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (card.pinned) Icon(Icons.Rounded.PushPin, "Pinned", Modifier.size(11.dp), tint = colors.textMuted)
                card.capsule?.let { WorkStatusCapsuleChip(it) }
                card.timestamp?.let {
                    Text(
                        it,
                        color = colors.textMuted,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                    )
                }
            }
            card.preview?.let {
                Text(
                    it,
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkCardMetadataRow(card)
        }
    }
}

@Composable
private fun WorkCardMetadataRow(card: WorkCardModel) {
    val colors = AdeTokens.colors
    val laneColor = card.laneColorArgb?.let { readableOnLightArgb(it, colors.isDark).toComposeColor() }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(card.providerLabel, color = colors.textMuted, fontSize = 11.sp, maxLines = 1)
        if (card.laneName != null) {
            Text("·", color = colors.textMuted.copy(alpha = 0.5f), fontSize = 11.sp)
            if (laneColor != null) Box(Modifier.size(6.dp).background(laneColor, CircleShape))
            else Icon(Icons.Rounded.AccountTree, null, Modifier.size(10.dp), tint = colors.textMuted)
            Text(
                card.laneName,
                Modifier.weight(1f, fill = false),
                color = laneColor ?: colors.textMuted,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        card.laneGit?.let { git ->
            if (git.dirty) Box(Modifier.size(6.dp).background(colors.warning, CircleShape))
            if (git.ahead > 0) AdeTintChip(
                git.ahead.toString(),
                colors.success,
                leading = { Icon(Icons.Rounded.ArrowUpward, "Commits ahead", Modifier.size(9.dp), tint = colors.success) },
            )
            if (git.behind > 0) AdeTintChip(
                git.behind.toString(),
                colors.warning,
                leading = { Icon(Icons.Rounded.ArrowDownward, "Commits behind", Modifier.size(9.dp), tint = colors.warning) },
            )
        }
        Spacer(Modifier.weight(1f))
        if (card.archived) Text("ARCHIVED", color = colors.warning, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun WorkStatusCapsuleChip(capsule: WorkStatusCapsule) {
    val colors = AdeTokens.colors
    val label = workStatusCapsuleLabel(capsule)
    when (capsule) {
        WorkStatusCapsule.NEEDS_YOU -> AdeTintChip(label, colors.warning, fillAlpha = 0.14f, strokeAlpha = 0.30f, horizontalPadding = 7, verticalPadding = 2)
        WorkStatusCapsule.FAILED -> AdeTintChip(label, colors.danger, fillAlpha = 0.14f, strokeAlpha = 0.30f, horizontalPadding = 7, verticalPadding = 2)
        WorkStatusCapsule.STALE -> AdeTintChip(
            label,
            colors.textSecondary,
            fillAlpha = 0f,
            strokeAlpha = 0.40f,
            horizontalPadding = 7,
            verticalPadding = 2,
            leading = { Icon(Icons.Rounded.Schedule, null, Modifier.size(8.dp), tint = colors.textSecondary) },
        )
    }
}

// ---------------------------------------------------------------------------
// Group header — WorkRootComponents.swift:315-438
// ---------------------------------------------------------------------------

@Composable
internal fun WorkGroupHeader(group: WorkGroup, collapsed: Boolean, onToggle: () -> Unit) {
    val colors = AdeTokens.colors
    val tint = when {
        group.orphan -> colors.warning
        group.colorArgb != null -> readableOnLightArgb(group.colorArgb, AdeTokens.colors.isDark).toComposeColor()
        else -> colors.textSecondary
    }
    Row(
        Modifier.fillMaxWidth()
            .pressableCard(onToggle)
            .padding(horizontal = 4.dp, vertical = 8.dp)
            .alpha(if (group.quiet) 0.72f else 1f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp), contentAlignment = Alignment.Center) {
            Icon(
                if (collapsed) Icons.AutoMirrored.Rounded.KeyboardArrowRight else Icons.Rounded.ExpandMore,
                if (collapsed) "Expand ${group.label}" else "Collapse ${group.label}",
                Modifier.size(9.dp),
                tint = colors.textMuted,
            )
        }
        Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
            Icon(
                if (group.orphan) Icons.Rounded.Warning else Icons.Rounded.AccountTree,
                null,
                Modifier.size(11.dp),
                tint = tint,
            )
        }
        Text(
            group.label,
            Modifier.weight(1f, fill = false),
            color = tint,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
        )
        Spacer(Modifier.weight(1f))
        if (group.quiet) {
            Box(
                Modifier.size(18.dp).border(1.dp, colors.textMuted.copy(alpha = 0.45f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    group.cards.size.toString(),
                    color = colors.textMuted,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        } else {
            Box(
                Modifier.clip(CircleShape)
                    .background(colors.surface.copy(alpha = 0.65f))
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            ) {
                Text(
                    group.cards.size.toString(),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Live pill — WorkRootComponents.swift:464-498
// ---------------------------------------------------------------------------

@Composable
internal fun WorkLivePill(counts: WorkLiveCounts) {
    if (!counts.visible) return
    val colors = AdeTokens.colors
    val tint = if (counts.attention) colors.warning else colors.success
    Row(
        Modifier.clip(CircleShape)
            .background(tint.copy(alpha = 0.14f))
            .border(0.75.dp, tint.copy(alpha = 0.28f), CircleShape)
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(10.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(10.dp).background(tint.copy(alpha = 0.30f), CircleShape))
            Box(Modifier.size(6.dp).background(tint, CircleShape))
        }
        Text(
            counts.label,
            color = tint,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

// ---------------------------------------------------------------------------
// Search + filter panel — WorkRootComponents.swift:9-249
// ---------------------------------------------------------------------------

@Composable
internal fun WorkSearchRow(
    query: String,
    onQueryChange: (String) -> Unit,
    filtersOpen: Boolean,
    onToggleFilters: () -> Unit,
) {
    val colors = AdeTokens.colors
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.weight(1f)
                .defaultMinSize(minHeight = 32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(colors.composer)
                .border(0.5.dp, colors.glassBorder, RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Rounded.Search, null, Modifier.size(12.dp), tint = colors.textMuted)
            TextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodySmall.copy(color = colors.textPrimary),
                placeholder = {
                    Text("Search sessions, lanes, output", color = colors.textMuted, fontSize = 12.sp, maxLines = 1)
                },
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
            )
            if (query.isNotEmpty()) Icon(
                Icons.Rounded.Close,
                "Clear search",
                Modifier.size(14.dp).clickable { onQueryChange("") },
                tint = colors.textMuted,
            )
        }
        Box(
            Modifier.size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(if (filtersOpen) colors.accent.copy(alpha = 0.12f) else colors.composer)
                .border(
                    0.75.dp,
                    if (filtersOpen) colors.accent.copy(alpha = 0.32f) else colors.glassBorder,
                    RoundedCornerShape(10.dp),
                )
                .pressableCard(onToggleFilters),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.Tune,
                "Filters",
                Modifier.size(16.dp),
                tint = if (filtersOpen) colors.accent else colors.textSecondary,
            )
        }
    }
}

@Composable
internal fun WorkActionRow(
    offline: Boolean,
    onStartChat: () -> Unit,
    onAddLane: () -> Unit,
) {
    val colors = AdeTokens.colors
    Row(
        Modifier.fillMaxWidth().alpha(if (offline) 0.55f else 1f),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.weight(1f)
                .height(44.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.accent)
                .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(12.dp))
                .then(if (offline) Modifier else Modifier.pressableCard(onStartChat)),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Rounded.Add, null, Modifier.size(16.dp), tint = colors.onAccent)
                Text("Start new chat", color = colors.onAccent, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
        }
        Box(
            Modifier.width(116.dp)
                .height(44.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.composer)
                .border(1.dp, colors.accent.copy(alpha = 0.30f), RoundedCornerShape(12.dp))
                .then(if (offline) Modifier else Modifier.pressableCard(onAddLane)),
            contentAlignment = Alignment.Center,
        ) {
            Text("Add lane", color = colors.accent, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
    }
}

@Composable
internal fun WorkFilterPanel(
    statusFilter: String,
    onStatusFilter: (String) -> Unit,
    organization: WorkOrganization,
    onOrganization: (WorkOrganization) -> Unit,
    laneOptions: List<Pair<String?, String>>,
    laneFilter: String?,
    onLaneFilter: (String?) -> Unit,
) {
    val colors = AdeTokens.colors
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.composer)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        FilterSection("STATUS") {
            listOf("all" to "All", "awaiting-input" to "Needs you", "active" to "Active", "idle" to "Idle", "settled" to "Done")
                .forEach { (id, label) ->
                    FilterChip(label, statusFilter == id) { onStatusFilter(id) }
                }
        }
        FilterSection("GROUP") {
            listOf(
                WorkOrganization.BY_LANE to "Lane",
                WorkOrganization.BY_STATUS to "Status",
                WorkOrganization.BY_TIME to "Time",
            ).forEach { (id, label) -> FilterChip(label, organization == id) { onOrganization(id) } }
        }
        if (laneOptions.isNotEmpty()) FilterSection("LANE") {
            laneOptions.forEach { (id, label) -> FilterChip(label, laneFilter == id) { onLaneFilter(id) } }
        }
    }
}

@Composable
private fun FilterSection(label: String, content: @Composable () -> Unit) {
    val colors = AdeTokens.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = colors.textMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) { content() }
    }
}

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    val tint = colors.accent
    Box(
        Modifier.clip(CircleShape)
            .background(if (selected) tint.copy(alpha = 0.14f) else colors.surface.copy(alpha = 0.50f))
            .border(
                0.75.dp,
                if (selected) tint.copy(alpha = 0.32f) else colors.glassBorder,
                CircleShape,
            )
            .pressableCard(onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            label,
            color = if (selected) tint else colors.textSecondary,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

// ---------------------------------------------------------------------------
// Floating tab bar — App/ContentView.swift:235-284 (Liquid Glass, hand-built)
// ---------------------------------------------------------------------------

internal data class AdeTabItem(val id: String, val label: String, val badge: Int = 0)

@Composable
internal fun AdeFloatingTabBar(
    items: List<AdeTabItem>,
    selected: String,
    onSelect: (String) -> Unit,
    icon: @Composable (String, Boolean) -> Unit,
) {
    val colors = AdeTokens.colors
    Box(Modifier.fillMaxWidth().padding(horizontal = 34.dp, vertical = 10.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .clip(CircleShape)
                .background(colors.glass)
                // `glassBorder`, not a hardcoded white: a 10%-white hairline is
                // invisible on the light page, leaving the bar edgeless.
                .border(1.dp, colors.glassBorder, CircleShape)
                .padding(6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items.forEach { item ->
                val isSelected = item.id == selected
                Box(
                    Modifier.weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (isSelected) colors.accent else Color.Transparent)
                        .pressableCard { onSelect(item.id) }
                        .padding(vertical = 9.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Box {
                            icon(item.id, isSelected)
                            if (item.badge > 0) Box(
                                Modifier.align(Alignment.TopEnd)
                                    .size(8.dp)
                                    .background(colors.warning, CircleShape),
                            )
                        }
                        Text(
                            item.label,
                            color = if (isSelected) colors.onAccent else colors.textSecondary,
                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                            fontSize = 14.sp,
                        )
                        if (item.badge > 0) Text(
                            item.badge.toString(),
                            color = if (isSelected) colors.onAccent else colors.textMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

private val previewCard = WorkCardModel(
    id = "s1",
    title = "Wire the Android roster card",
    preview = "Applied the provider tint table and re-ran the unit tests.",
    provider = "claude",
    providerLabel = "Claude",
    providerTintArgb = 0xFFFF9F0AL,
    kind = SessionKind.CHAT,
    status = "awaiting-input",
    rowTint = WorkRowTint.WARNING,
    capsule = WorkStatusCapsule.NEEDS_YOU,
    timestamp = "4m",
    settled = false,
    pinned = true,
    archived = false,
    laneId = "lane-1",
    laneName = "android-companion",
    laneColorArgb = 0xFFA78BFAL,
    laneGit = LaneGitState(dirty = true, ahead = 3, behind = 1),
)

@Preview(name = "Session card dark", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewSessionCardDark() = AdeTheme(dark = true) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        WorkSessionCard(previewCard, {})
        WorkSessionCard(
            previewCard.copy(
                id = "s2",
                title = "Codex: migrate lane snapshot parser",
                provider = "codex",
                providerLabel = "Codex",
                providerTintArgb = 0xFF0A84FFL,
                status = "settled",
                settled = true,
                pinned = false,
                capsule = null,
                rowTint = WorkRowTint.SECONDARY,
                preview = "Done: rebuilt the snapshot parser.",
            ),
            {},
        )
    }
}

@Preview(name = "Session card light", showBackground = true, backgroundColor = 0xFFF5F3F0)
@Composable
private fun PreviewSessionCardLight() = AdeTheme(dark = false) {
    Column(Modifier.padding(12.dp)) { WorkSessionCard(previewCard, {}) }
}

@Preview(name = "Work chrome", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewWorkChrome() = AdeTheme(dark = true) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        WorkLivePill(WorkLiveCounts(live = 4, waiting = 2))
        WorkSearchRow("", {}, filtersOpen = true, onToggleFilters = {})
        WorkActionRow(offline = false, onStartChat = {}, onAddLane = {})
        WorkFilterPanel(
            statusFilter = "all",
            onStatusFilter = {},
            organization = WorkOrganization.BY_LANE,
            onOrganization = {},
            laneOptions = listOf(null to "All lanes", "lane-1" to "android-companion"),
            laneFilter = null,
            onLaneFilter = {},
        )
        WorkGroupHeader(
            WorkGroup("lane-1", "android-companion", 0xFFA78BFAL, listOf(previewCard)),
            collapsed = false,
            onToggle = {},
        )
        WorkGroupHeader(
            WorkGroup("lane-2", "quiet-lane", 0xFF34D399L, listOf(previewCard.copy(settled = true))),
            collapsed = true,
            onToggle = {},
        )
    }
}
