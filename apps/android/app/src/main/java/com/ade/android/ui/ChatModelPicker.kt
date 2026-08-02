package com.ade.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Bottom-sheet model picker, ported from
 * apps/ios/ADE/Views/Work/WorkModelPickerSheet.swift.
 *
 * Two data facts are load-bearing and must never be hardcoded:
 *  - **Effort levels are host-supplied** (`model.reasoningEfforts[].effort`,
 *    lowercased and de-duped). An empty list means no effort control.
 *  - **Fast mode is a service tier** — supported iff `serviceTiers` contains
 *    "fast".
 * Selecting a different model resets effort to that model's default and fast
 * mode to false ([selectModel]).
 */
@Composable
internal fun ChatModelPicker(
    options: List<ChatModelOption>,
    selection: ChatModelSelection,
    favouriteIds: Set<String>,
    recentIds: List<String>,
    onSelect: (ChatModelSelection) -> Unit,
    onToggleFavourite: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    /** False when the host does not allow `chat.updateSession` on this session. */
    enabled: Boolean = true,
) {
    val colors = AdeTokens.colors
    var query by remember { mutableStateOf("") }
    val rail = remember(options, favouriteIds, recentIds) {
        modelRailItems(options, favouriteIds, recentIds)
    }
    // Keyed on the rail *keys*, not the list instance: every host round-trip
    // (chat.updateSession refreshes the session lists) hands us a fresh
    // ChatModelOption list, and re-keying on identity would snap the rail back to
    // the first provider after every effort or fast-mode tap.
    val railKeys = rail.map(ModelRailItem::key)
    var activeRailKey by remember(railKeys) {
        mutableStateOf(rail.firstOrNull { it.kind == ModelRailKind.PROVIDER }?.key ?: rail.first().key)
    }
    val activeRail = rail.firstOrNull { it.key == activeRailKey } ?: rail.first()
    val visible = remember(activeRail, options, query, favouriteIds, recentIds) {
        modelsForRail(activeRail, options, favouriteIds, recentIds, query)
    }
    val current = options.firstOrNull { it.id == selection.modelId }

    Column(modifier.fillMaxWidth().background(colors.page)) {
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier
                    .weight(1f)
                    .background(colors.recessed.copy(alpha = 0.55f), RoundedCornerShape(10.dp))
                    .border(0.5.dp, colors.glassBorder, RoundedCornerShape(10.dp))
                    .padding(horizontal = 10.dp, vertical = 9.dp),
            ) {
                if (query.isEmpty()) {
                    Text("Search models…", fontSize = 14.sp, color = colors.textMuted)
                }
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
                    cursorBrush = SolidColor(colors.accent),
                )
            }
            Box(
                Modifier
                    .size(38.dp)
                    .background(colors.surface.copy(alpha = 0.6f), CircleShape)
                    .border(0.6.dp, colors.glassBorder, CircleShape)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("✕", fontSize = 14.sp, color = colors.textSecondary)
            }
        }

        Row(Modifier.fillMaxWidth().weight(1f, fill = false).height(420.dp)) {
            Column(
                Modifier
                    .width(60.dp)
                    .fillMaxHeight()
                    .background(colors.recessed.copy(alpha = 0.35f))
                    .padding(vertical = 8.dp, horizontal = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                rail.forEach { item ->
                    RailItem(item, item.key == activeRailKey) { activeRailKey = item.key }
                }
            }
            Box(Modifier.width(0.5.dp).fillMaxHeight().background(colors.glassBorder))
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ProviderMark(activeRail.key.takeIf { activeRail.kind == ModelRailKind.PROVIDER }, 18.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        activeRail.label,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                    )
                    activeRail.badge?.let {
                        Spacer(Modifier.width(6.dp))
                        CountBadge(it)
                    }
                }
                LazyColumn(
                    Modifier.fillMaxWidth().weight(1f).padding(horizontal = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(visible, key = ChatModelOption::id) { option ->
                        ModelRow(
                            option = option,
                            selected = option.id == selection.modelId,
                            selection = selection,
                            favourite = option.id in favouriteIds,
                            enabled = enabled,
                            onSelect = { onSelect(selectModel(option)) },
                            onEffort = { onSelect(selection.copy(effort = it)) },
                            onFastMode = { onSelect(selection.copy(fastMode = it)) },
                            onToggleFavourite = { onToggleFavourite(option.id) },
                        )
                    }
                    if (visible.isEmpty()) {
                        item {
                            Text("No models here.", fontSize = 13.sp, color = colors.textMuted)
                        }
                    }
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(colors.surface.copy(alpha = 0.5f))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ProviderMark(current?.provider, 18.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    "CURRENT MODEL",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.4.sp,
                    color = colors.textMuted,
                )
                Text(
                    current?.name ?: "No model selected",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(
                Modifier
                    .background(colors.recessed.copy(alpha = 0.5f), CircleShape)
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                selection.effort?.let {
                    Text(
                        reasoningEffortAbbreviation(it),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textSecondary,
                    )
                }
                Text("⚡", fontSize = 10.sp, color = colors.warning)
                Text(
                    fastModeLabel(current, selection.fastMode),
                    fontSize = 10.sp,
                    color = colors.textSecondary,
                )
            }
        }
    }
}

@Composable
private fun RailItem(item: ModelRailItem, active: Boolean, onClick: () -> Unit) {
    val colors = AdeTokens.colors
    Box(
        Modifier
            .size(44.dp)
            .then(
                if (active) {
                    Modifier
                        .background(Color.White.copy(alpha = 0.07f), RoundedCornerShape(8.dp))
                        .border(0.8.dp, Color.White.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
                } else {
                    Modifier
                },
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        when (item.kind) {
            ModelRailKind.FAVOURITES -> Text("★", fontSize = 16.sp, color = colors.warning)
            ModelRailKind.RECENTS -> Box(contentAlignment = Alignment.TopEnd) {
                Text("🕘", fontSize = 15.sp)
                item.badge?.let { Text("$it", fontSize = 8.sp, color = colors.textMuted) }
            }
            ModelRailKind.PROVIDER -> ProviderMark(item.key, 18.dp)
        }
    }
}

@Composable
private fun CountBadge(count: Int) {
    val colors = AdeTokens.colors
    Text(
        "$count",
        Modifier
            .background(colors.surface.copy(alpha = 0.6f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 1.dp),
        fontSize = 10.sp,
        color = colors.textMuted,
    )
}

@Composable
private fun ModelRow(
    option: ChatModelOption,
    selected: Boolean,
    selection: ChatModelSelection,
    favourite: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
    onEffort: (String) -> Unit,
    onFastMode: (Boolean) -> Unit,
    onToggleFavourite: () -> Unit,
) {
    val colors = AdeTokens.colors
    val shape = RoundedCornerShape(if (selected) 11.dp else 10.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (selected) colors.accent.copy(alpha = 0.10f) else colors.surface.copy(alpha = 0.45f), shape)
            .border(
                if (selected) 1.dp else 0.5.dp,
                if (selected) colors.accent.copy(alpha = 0.42f) else colors.glassBorder.copy(alpha = 0.70f),
                shape,
            )
            .clickable(enabled = enabled, onClick = onSelect)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ProviderMark(option.provider, 20.dp)
            Text(
                option.name,
                Modifier.weight(1f),
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (favourite) "★" else "☆",
                Modifier.clickable(onClick = onToggleFavourite).padding(4.dp),
                fontSize = 14.sp,
                color = if (favourite) colors.warning else colors.textMuted,
            )
        }
        if (selected) {
            // Host-supplied efforts only. No efforts means no effort control.
            if (option.efforts.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    option.efforts.forEach { effort ->
                        val active = effort == selection.effort
                        Text(
                            reasoningEffortDisplayName(effort),
                            Modifier
                                .background(
                                    if (active) colors.accent else colors.recessed.copy(alpha = 0.5f),
                                    CircleShape,
                                )
                                .clickable(enabled = enabled) { onEffort(effort) }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (active) colors.onAccent else colors.textSecondary,
                        )
                    }
                }
            }
            if (option.supportsFastMode) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "⚡ Fast mode ${if (selection.fastMode) "On" else "Off"}",
                        Modifier.weight(1f),
                        fontSize = 12.sp,
                        color = colors.textSecondary,
                    )
                    Switch(
                        checked = selection.fastMode,
                        onCheckedChange = onFastMode,
                        enabled = enabled,
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = Color.White,
                            checkedTrackColor = colors.warning,
                        ),
                    )
                }
            }
        }
    }
}
