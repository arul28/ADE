package com.ade.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountTree
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Circle
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Layers
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.automirrored.rounded.MergeType
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Lane card, ported from apps/ios/ADE/Views/Lanes/LaneComponents.swift:494-655
 * and Views/LanesTabView.swift:65-161.
 */
internal data class LaneCardModel(
    val id: String,
    val name: String,
    val branch: String?,
    val colorArgb: Long,
    val laneType: String?,
    val archived: Boolean,
    val git: LaneGitState,
    val pullRequest: LanePrTag? = null,
    val devicesOpen: Int = 0,
)

@Composable
internal fun laneTypeBadgeLabel(model: LaneCardModel): String? = when {
    model.archived -> "Archived"
    model.laneType == "primary" -> "Primary"
    model.laneType == "attached" -> "Attached"
    else -> null
}

@Composable
internal fun LaneCard(
    model: LaneCardModel,
    open: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    val lane = model.colorArgb.toComposeColor()
    val shape = RoundedCornerShape(14.dp)
    // Host lane colours are chosen against the dark desktop. On the light page
    // a raw #22D3EE or #A3E635 title on its own 10%-alpha wash is unreadable, so
    // the text tint goes through the same luminance clamp the Hub rows use. The
    // wash itself keeps the raw colour — it is the identity cue.
    val laneText = readableOnLightArgb(model.colorArgb, colors.isDark).toComposeColor()
        .copy(alpha = LANE_TINT_ALPHAS.text)
    Column(
        modifier
            .fillMaxWidth()
            .then(if (open) Modifier.shadow(10.dp, shape, ambientColor = lane, spotColor = lane) else Modifier)
            .pressableCard(onClick)
            .clip(shape)
            .background(lane.copy(alpha = LANE_TINT_ALPHAS.background))
            .border(
                if (open) 1.25.dp else 0.75.dp,
                if (open) lane.copy(alpha = LANE_TINT_ALPHAS.accentBar * 0.55f)
                else lane.copy(alpha = LANE_TINT_ALPHAS.border),
                shape,
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.AccountTree, null, Modifier.size(12.dp), tint = laneText)
            }
            Text(
                model.name,
                // One weighted child only. Paired with the trailing
                // `Spacer(weight(1f))` this split the free width in half, so
                // "codex/worker-windows-proc-guards" ellipsized at 40% of a row
                // that was otherwise empty.
                Modifier.weight(1f),
                color = laneText,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            laneTypeBadgeLabel(model)?.let { label ->
                val tint = if (label == "Primary") colors.accent else colors.textMuted
                AdeTintChip(label, tint, fillAlpha = 0.12f, horizontalPadding = 7, verticalPadding = 3)
            }
            model.pullRequest?.let { LanePrBadge(it) }
            if (model.devicesOpen > 0) Icon(
                Icons.Rounded.PhoneAndroid,
                "Open on ${model.devicesOpen} device(s)",
                Modifier.size(12.dp),
                tint = colors.textMuted,
            )
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, Modifier.size(16.dp), tint = colors.textMuted)
        }
        shortBranchName(model.branch)?.let { branch ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Icon(Icons.Rounded.AccountTree, null, Modifier.size(10.dp), tint = colors.textMuted.copy(alpha = 0.7f))
                Text(
                    branch,
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
            }
        }
        LaneStatusChips(model.git)
    }
}

@Composable
private fun LaneStatusChips(git: LaneGitState) {
    val colors = AdeTokens.colors
    val hasAny = git.dirty || git.ahead > 0 || git.behind > 0 || git.children > 0 ||
        git.linearIdentifier != null || git.pinned
    if (!hasAny) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (git.dirty) AdeTintChip(
            "dirty",
            colors.warning,
            leading = { Icon(Icons.Rounded.Circle, null, Modifier.size(8.dp), tint = colors.warning) },
        )
        if (git.ahead > 0) AdeTintChip(
            git.ahead.toString(),
            colors.success,
            leading = { Icon(Icons.Rounded.ArrowUpward, "Commits ahead", Modifier.size(8.dp), tint = colors.success) },
        )
        if (git.behind > 0) AdeTintChip(
            git.behind.toString(),
            colors.warning,
            leading = { Icon(Icons.Rounded.ArrowDownward, "Commits behind", Modifier.size(8.dp), tint = colors.warning) },
        )
        if (git.children > 0) AdeTintChip(
            git.children.toString(),
            colors.textMuted,
            leading = { Icon(Icons.Rounded.Layers, "Child lanes", Modifier.size(8.dp), tint = colors.textMuted) },
        )
        git.linearIdentifier?.let {
            AdeTintChip(it, colors.accent, leading = { Icon(Icons.Rounded.Link, null, Modifier.size(8.dp), tint = colors.accent) })
        }
        if (git.pinned) AdeTintChip(
            "pinned",
            colors.accent,
            leading = { Icon(Icons.Rounded.PushPin, null, Modifier.size(8.dp), tint = colors.accent) },
        )
    }
}

@Composable
internal fun LanePrBadge(tag: LanePrTag) {
    val colors = AdeTokens.colors
    val tint = when (lanePrTint(tag)) {
        LanePrTint.SUCCESS -> colors.success
        LanePrTint.WARNING -> colors.warning
        LanePrTint.DANGER -> colors.danger
        LanePrTint.ACCENT -> colors.accent
    }
    Row(
        Modifier.clip(RoundedCornerShape(7.dp))
            .background(tint.copy(alpha = 0.12f))
            .border(0.6.dp, tint.copy(alpha = 0.28f), RoundedCornerShape(7.dp))
            .padding(horizontal = 7.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(Icons.AutoMirrored.Rounded.MergeType, null, Modifier.size(9.dp), tint = tint)
        Text(
            lanePrBadgeLabel(tag),
            color = tint,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

/** "LANES" section label — LanesTabView.swift:262-291. */
@Composable
internal fun LaneSectionLabel(text: String) {
    Text(
        text,
        color = AdeTokens.colors.textMuted,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.6.sp,
    )
}

@Composable
internal fun LaneAddButton(enabled: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Box(
        Modifier.fillMaxWidth()
            .shadow(8.dp, RoundedCornerShape(12.dp), ambientColor = colors.accent, spotColor = colors.accent)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) colors.accent else colors.accent.copy(alpha = 0.55f))
            .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(12.dp))
            .then(if (enabled) Modifier.pressableCard(onClick) else Modifier)
            .padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("+ Add lane", color = colors.onAccent, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    }
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

private val previewLanes = listOf(
    LaneCardModel(
        id = "lane-primary",
        name = "main",
        branch = "refs/heads/main",
        colorArgb = 0xFFA78BFAL,
        laneType = "primary",
        archived = false,
        git = LaneGitState(dirty = false, ahead = 0, behind = 2, children = 3),
    ),
    LaneCardModel(
        id = "lane-1",
        name = "android-companion-parity",
        branch = "origin/ade/android-app-feasibility",
        colorArgb = 0xFF34D399L,
        laneType = "worktree",
        archived = false,
        git = LaneGitState(dirty = true, ahead = 5, behind = 0, linearIdentifier = "ADE-412", pinned = true),
        pullRequest = LanePrTag(number = 984, state = "open"),
        devicesOpen = 1,
    ),
    LaneCardModel(
        id = "lane-2",
        name = "old-experiment",
        branch = "ade/old-experiment",
        colorArgb = 0xFFF87171L,
        laneType = "worktree",
        archived = true,
        git = LaneGitState(),
        pullRequest = LanePrTag(number = 901, state = "merged"),
    ),
)

@Preview(name = "Lanes dark", showBackground = true, backgroundColor = 0xFF0C0B10)
@Composable
private fun PreviewLanesDark() = AdeTheme(dark = true) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LaneAddButton(enabled = true) {}
        LaneSectionLabel("LANES")
        previewLanes.forEachIndexed { index, lane -> LaneCard(lane, open = index == 1, onClick = {}) }
    }
}

@Preview(name = "Lanes light", showBackground = true, backgroundColor = 0xFFF5F3F0)
@Composable
private fun PreviewLanesLight() = AdeTheme(dark = false) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LaneAddButton(enabled = true) {}
        LaneSectionLabel("LANES")
        previewLanes.forEach { lane -> LaneCard(lane, open = false, onClick = {}) }
    }
}
