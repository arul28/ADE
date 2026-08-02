package com.ade.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * ADE-styled modal dialog.
 *
 * Stock [androidx.compose.material3.AlertDialog] renders a flat tonal surface
 * with Material's default type ramp, which reads as a different app once it sits
 * on top of the restyled Hub/Work/Lanes/Settings surfaces. This is the same
 * glass-card idiom those screens use (token card fill, hairline `glassBorder`,
 * 20dp radius) with the pill action buttons from Settings.
 *
 * Purely presentational — callers keep their own state and callbacks.
 */
@Composable
fun AdeDialog(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    confirmLabel: String? = null,
    onConfirm: (() -> Unit)? = null,
    confirmEnabled: Boolean = true,
    destructive: Boolean = false,
    dismissLabel: String = "Cancel",
    body: @Composable ColumnScope.() -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AdeDialogCard(
            title = title,
            // Explicit width: `usePlatformDefaultWidth = false` is needed so the
            // card is not boxed into Material's narrow alert width, but it also
            // removes any width cap, so set one here.
            modifier = modifier.padding(horizontal = 24.dp).widthIn(max = 420.dp).imePadding(),
            icon = icon,
            iconTint = iconTint,
            confirmLabel = confirmLabel,
            onConfirm = onConfirm,
            confirmEnabled = confirmEnabled,
            destructive = destructive,
            dismissLabel = dismissLabel,
            onDismiss = onDismiss,
            body = body,
        )
    }
}

/**
 * The dialog card itself, without the [Dialog] window. Split out so it can be
 * rendered by `@Preview` (which does not host platform dialogs).
 */
@Composable
fun AdeDialogCard(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    confirmLabel: String? = null,
    onConfirm: (() -> Unit)? = null,
    confirmEnabled: Boolean = true,
    destructive: Boolean = false,
    dismissLabel: String = "Cancel",
    onDismiss: () -> Unit = {},
    body: @Composable ColumnScope.() -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(20.dp)
    val accent = if (destructive) colors.danger else colors.accent
    run {
        Column(
            modifier
                .fillMaxWidth()
                .clip(shape)
                .background(dialogFill(colors))
                .border(1.dp, colors.glassBorder, shape)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (icon != null) {
                    Box(
                        Modifier
                            .size(30.dp)
                            .clip(RoundedCornerShape(9.dp))
                            .background((iconTint ?: accent).copy(alpha = 0.14f))
                            .border(0.75.dp, (iconTint ?: accent).copy(alpha = 0.28f), RoundedCornerShape(9.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(icon, null, Modifier.size(16.dp), tint = iconTint ?: accent)
                    }
                    Spacer(Modifier.size(10.dp))
                }
                Text(
                    title,
                    Modifier.weight(1f),
                    color = colors.textPrimary,
                    fontSize = 18.sp,
                    lineHeight = 24.sp,
                    fontWeight = FontWeight.Bold,
                    // Titles interpolate machine and lane names, which can be
                    // long enough to need two lines before they ellipsize.
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            body()
            Spacer(Modifier.height(2.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AdePillButton(dismissLabel, colors.textSecondary, Modifier.weight(1f), onClick = onDismiss)
                if (confirmLabel != null) {
                    AdePillButton(
                        confirmLabel,
                        accent,
                        Modifier.weight(1f),
                        filled = true,
                        enabled = confirmEnabled,
                        onClick = { onConfirm?.invoke() },
                    )
                }
            }
        }
    }
}

/**
 * Bare ADE dialog container for content that brings its own header and actions
 * (the model picker, the approval sheet). Same card idiom as [AdeDialog] with no
 * title row and no button row.
 */
@Composable
fun AdeDialogSurface(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(20.dp)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            modifier
                .padding(horizontal = 16.dp)
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .imePadding()
                .clip(shape)
                .background(dialogFill(colors))
                .border(1.dp, colors.glassBorder, shape)
                .padding(14.dp),
            content = content,
        )
    }
}

/**
 * Dialogs float over the aurora background, so unlike the in-page settings cards
 * they need a near-opaque fill — a 0.70-alpha card let the Hub's lane rows show
 * through the text.
 */
private fun dialogFill(colors: AdeColors): Color =
    if (colors.isDark) Color(0xFF1C1A2E) else Color(0xFFFCFBF9)

/** Pill action button — the dialog/settings shared idiom. */
@Composable
fun AdePillButton(
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
                    // A disabled filled button keeps a washed-out fill but drops
                    // to the outlined foreground: white-on-35%-green was the
                    // lowest-contrast text anywhere in the app.
                    filled -> tint.copy(alpha = 0.14f)
                    else -> colors.surface.copy(alpha = if (colors.isDark) 0.45f else 0.70f)
                },
            )
            .border(
                0.75.dp,
                when {
                    filled && enabled -> Color.White.copy(alpha = 0.18f)
                    else -> tint.copy(alpha = 0.30f)
                },
                shape,
            )
            .then(if (enabled) Modifier.pressableCard(onClick) else Modifier)
            .padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            // `onAccent` is only the correct foreground for the accent fill. On
            // the destructive red it rendered as dark purple on red.
            color = when {
                !enabled -> tint.copy(alpha = 0.45f)
                filled && tint == colors.accent -> colors.onAccent
                filled -> Color.White
                else -> tint
            },
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/** Supporting copy inside a dialog body. */
@Composable
fun AdeDialogText(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier,
        color = AdeTokens.colors.textSecondary,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    )
}

/** Token-styled text field for dialog and sheet bodies. */
@Composable
fun AdeTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minLines: Int = 1,
) {
    val colors = AdeTokens.colors
    OutlinedTextField(
        value,
        onValueChange,
        modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = singleLine,
        minLines = minLines,
        shape = RoundedCornerShape(12.dp),
        textStyle = MaterialTheme.typography.bodyLarge,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colors.accent,
            unfocusedBorderColor = colors.border,
            focusedLabelColor = colors.accent,
            unfocusedLabelColor = colors.textMuted,
            focusedTextColor = colors.textPrimary,
            unfocusedTextColor = colors.textPrimary,
            cursorColor = colors.accent,
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent,
        ),
    )
}
