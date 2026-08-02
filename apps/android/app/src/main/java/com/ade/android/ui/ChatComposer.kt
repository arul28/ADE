package com.ade.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The chat composer, ported from
 * apps/ios/ADE/Views/Work/WorkChatComposerAndInputViews.swift.
 *
 * Container radius 24, composerBackground fill, 1pt glassBorder, inner pad
 * h12/v10. Control row: attach · access mode · model pill · Spacer ·
 * context ring · mic · send/stop.
 */
@Composable
internal fun ChatComposer(
    text: String,
    onTextChange: (String) -> Unit,
    placeholder: String,
    modelLabel: String?,
    modelProvider: String?,
    effort: String?,
    fastMode: Boolean,
    accessMode: String,
    contextRing: ContextRingState,
    turnLive: Boolean,
    canSend: Boolean,
    canAttach: Boolean,
    onAttach: () -> Unit,
    onOpenModelPicker: () -> Unit,
    onCycleAccessMode: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(24.dp)
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.composer, shape)
            .border(1.dp, colors.glassBorder, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.fillMaxWidth().heightIn(min = 24.dp, max = 140.dp)) {
            if (text.isEmpty()) {
                Text(placeholder, fontSize = 15.sp, color = colors.textMuted)
            }
            BasicTextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, color = colors.textPrimary),
                cursorBrush = SolidColor(colors.accent),
            )
        }
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircleGlyphButton("+", enabled = canAttach, onClick = onAttach)
            AccessModeControl(accessMode, onCycleAccessMode)
            ModelPill(modelLabel, modelProvider, effort, fastMode, onOpenModelPicker)
            Spacer(Modifier.weight(1f))
            if (contextRing.visible) ContextRing(contextRing)
            if (turnLive) StopButton(onStop) else SendButton(canSend && text.isNotBlank(), onSend)
        }
    }
}

@Composable
private fun CircleGlyphButton(glyph: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Box(
        Modifier
            .size(44.dp)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(28.dp)
                .background(colors.surface.copy(alpha = 0.38f), CircleShape)
                .border(0.6.dp, colors.border.copy(alpha = 0.28f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                glyph,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = if (enabled) colors.textSecondary else colors.textMuted.copy(alpha = 0.4f),
            )
        }
    }
}

@Composable
private fun AccessModeControl(mode: String, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Text(
        mode,
        Modifier
            .border(0.5.dp, colors.border.copy(alpha = 0.22f), CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = colors.textSecondary,
        maxLines = 1,
    )
}

/** provider logo · model name · · · effort abbreviation · bolt · chevron. */
@Composable
internal fun ModelPill(
    modelLabel: String?,
    provider: String?,
    effort: String?,
    fastMode: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    Row(
        modifier
            .border(0.5.dp, colors.border.copy(alpha = 0.22f), CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ProviderMark(provider, 16.dp)
        Text(
            modelLabel ?: "Model",
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (effort != null) {
            Text("·", fontSize = 12.sp, color = colors.textMuted.copy(alpha = 0.5f))
            Text(
                reasoningEffortAbbreviation(effort),
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textMuted,
            )
        }
        if (fastMode) Text("⚡", fontSize = 10.sp, color = colors.warning)
        Text("⌄", fontSize = 9.sp, color = colors.textMuted)
    }
}

/**
 * Provider mark. Uses the branded artwork ported from the iOS
 * `Provider*.imageset` assets when one exists, and falls back to the tinted
 * provider initial otherwise.
 */
@Composable
internal fun ProviderMark(provider: String?, size: androidx.compose.ui.unit.Dp) {
    val tint = argbColor(chatSurfaceAccentArgb(provider))
    val logo = providerLogoRes(provider)
    Box(
        Modifier.size(size).background(
            if (logo != null) Color.Transparent else tint.copy(alpha = 0.28f),
            CircleShape,
        ),
        contentAlignment = Alignment.Center,
    ) {
        if (logo != null) {
            androidx.compose.foundation.Image(
                painter = androidx.compose.ui.res.painterResource(logo),
                contentDescription = providerShortLabel(provider, com.ade.android.SessionKind.CHAT),
                modifier = Modifier.size(size),
            )
        } else {
            Text(
                providerGlyph(provider, com.ade.android.SessionKind.CHAT),
                fontSize = (size.value * 0.45f).sp,
                fontWeight = FontWeight.Bold,
                color = tint,
            )
        }
    }
}

/**
 * 22dp ring, 2.5dp round cap, trimmed 0…ratio, rotated -90°.
 * ≥0.90 danger, ≥0.70 warning, else the cyan-blue #38BCF7 — NOT accent.
 * Unknown renders a white@12% ring with "?"; compacting renders "…".
 */
@Composable
internal fun ContextRing(state: ContextRingState, modifier: Modifier = Modifier) {
    val colors = AdeTokens.colors
    val tint = when (state.tone) {
        ContextRingTone.DANGER -> colors.danger
        ContextRingTone.WARNING -> colors.warning
        ContextRingTone.OK -> argbColor(CONTEXT_RING_OK_ARGB)
        ContextRingTone.UNKNOWN -> Color.White.copy(alpha = 0.12f)
    }
    val ratio = state.ratio?.toFloat()?.coerceIn(0f, 1f)
    val strokeWidth = if (state.tone == ContextRingTone.UNKNOWN && ratio == null) 1.5f else 2.5f
    Box(
        modifier
            .size(22.dp)
            .rotate(-90f)
            .drawBehind {
                val stroke = Stroke(width = strokeWidth * density, cap = StrokeCap.Round)
                val inset = stroke.width / 2f
                val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
                drawArc(
                    color = Color.White.copy(alpha = 0.10f),
                    startAngle = 0f,
                    sweepAngle = 360f,
                    useCenter = false,
                    topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
                    size = arcSize,
                    style = stroke,
                )
                if (ratio != null && ratio > 0f) {
                    drawArc(
                        color = tint,
                        startAngle = 0f,
                        sweepAngle = 360f * ratio,
                        useCenter = false,
                        topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
                        size = arcSize,
                        style = stroke,
                    )
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.rotate(90f)) {
            Text(
                state.label,
                fontSize = if ((state.ratio ?: 0.0) >= 1.0) 7.sp else 8.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                color = colors.textPrimary.copy(alpha = 0.78f),
            )
        }
    }
}

@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Box(
        Modifier
            .size(28.dp)
            .background(
                if (enabled) Color.White.copy(alpha = 0.90f) else Color.White.copy(alpha = 0.06f),
                CircleShape,
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "↑",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = if (enabled) Color(0xFF1F1F24) else colors.textSecondary.copy(alpha = 0.20f),
        )
    }
}

@Composable
private fun StopButton(onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Box(
        Modifier
            .size(28.dp)
            .background(colors.danger.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .border(1.dp, colors.danger.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(10.dp).background(colors.danger.copy(alpha = 0.85f), RoundedCornerShape(2.dp)))
    }
}
