package com.ade.android.ui

import com.ade.android.SessionKind
import com.ade.android.UiLane
import com.ade.android.UiSession
import java.time.Instant

/**
 * Pure presentation logic shared by the Work and Lanes tabs.
 *
 * Everything here is deliberately framework-free (ARGB longs rather than
 * Compose `Color`) so it runs in plain JVM unit tests and mirrors the Swift
 * sources one-for-one:
 *   - apps/ios/ADE/Views/Work/WorkStatusAndFormattingHelpers.swift
 *   - apps/ios/ADE/Views/Work/WorkRootComponents.swift
 *   - apps/ios/ADE/Views/Work/WorkSessionGrouping.swift
 *   - apps/ios/ADE/Views/Lanes/LaneColorPalette.swift
 *   - apps/ios/ADE/Views/Lanes/LaneComponents.swift
 *
 * Nothing in this file may log or persist session content.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Derives the provider family from a session's `toolType`.
 *
 * `TerminalSessionSummary` (apps/desktop/src/shared/types/sessions.ts) carries
 * NO top-level `provider` field — only `toolType` (and, for chat-backed rows, a
 * `resumeMetadata.provider`). So `work.listSessions` legitimately returns no
 * provider for every row, and reading `provider` alone leaves every card on the
 * generic tile. Both other clients derive it instead:
 *   - iOS: `chatSummary?.provider ?? session.toolType`, normalized by
 *     `workChatProviderFamilyFromToolType` (WorkSessionDestinationView.swift:436).
 *   - host: `providerFromTool` (apps/desktop/src/main/utils/terminalSessionSignals.ts:152).
 *
 * This mirrors the host's `providerFromTool` mapping, including its `null` for
 * unrecognized tool types — that null is load-bearing, since it keeps plain
 * shell sessions on the "Shell" label rather than inventing a provider named
 * after their binary (iOS's variant returns the raw string and gets this wrong).
 */
internal fun providerFromToolType(toolType: String?): String? {
    val raw = toolType?.trim()?.lowercase().orEmpty()
    if (raw.isEmpty()) return null
    return when {
        raw.startsWith("claude") -> "claude"
        raw.startsWith("codex") -> "codex"
        raw.startsWith("cursor") -> "cursor"
        raw.startsWith("droid") || raw.startsWith("factory") -> "droid"
        raw.startsWith("opencode") -> "opencode"
        else -> null
    }
}

/**
 * Session-card provider tints. Source: WorkStatusAndFormattingHelpers.swift:438-462.
 * These are the iOS *system* colours, deliberately not the ADE brand palette —
 * the brand hexes are used by the composer, not by the roster card.
 */
internal fun providerTintArgb(provider: String?, accent: Long): Long =
    when (provider?.trim()?.lowercase()) {
        "claude", "anthropic" -> 0xFFFF9F0AL
        "codex", "openai" -> 0xFF0A84FFL
        "opencode" -> 0xFF40C8E0L
        "cursor" -> 0xFF5E5CE6L
        "droid", "factory" -> 0xFF8E8E93L
        "ollama" -> 0xFF30D158L
        "lmstudio" -> 0xFFFF9F0AL
        "google", "gemini" -> 0xFFFFD60AL
        else -> accent
    }

/** Short roster label. The model name is deliberately never shown on the card. */
internal fun providerShortLabel(provider: String?, kind: SessionKind): String =
    when (provider?.trim()?.lowercase()) {
        "claude", "anthropic" -> "Claude"
        "codex", "openai" -> "Codex"
        "opencode" -> "OpenCode"
        "cursor" -> "Cursor"
        "droid", "factory" -> "Droid"
        "ollama" -> "Ollama"
        "lmstudio" -> "LM Studio"
        "google", "gemini" -> "Gemini"
        null, "" -> if (kind == SessionKind.TERMINAL) "Shell" else "Agent"
        else -> provider.trim().replaceFirstChar(Char::uppercase)
    }

/**
 * Branded provider artwork, ported from the iOS `Provider*.imageset` assets into
 * `res/drawable/ic_provider_*.xml`. Returns `null` for providers with no asset —
 * those keep the tinted-initial fallback ([providerGlyph]).
 */
internal fun providerLogoRes(provider: String?): Int? = when (provider?.trim()?.lowercase()) {
    "claude" -> com.ade.android.R.drawable.ic_provider_claude
    "anthropic" -> com.ade.android.R.drawable.ic_provider_anthropic
    "codex" -> com.ade.android.R.drawable.ic_provider_codex
    "openai" -> com.ade.android.R.drawable.ic_provider_openai
    "cursor" -> com.ade.android.R.drawable.ic_provider_cursor
    "opencode" -> com.ade.android.R.drawable.ic_provider_opencode
    "droid", "factory" -> com.ade.android.R.drawable.ic_provider_droid
    "github" -> com.ade.android.R.drawable.ic_provider_github
    else -> null
}

/** Single-glyph mark drawn inside the 32dp provider tile when no asset exists. */
internal fun providerGlyph(provider: String?, kind: SessionKind): String =
    when (providerShortLabel(provider, kind)) {
        "Shell" -> ">_"
        "OpenCode" -> "OC"
        "LM Studio" -> "LM"
        else -> providerShortLabel(provider, kind).take(1).uppercase()
    }

// ---------------------------------------------------------------------------
// Lane colour palette — LaneColorPalette.swift:15-28
// ---------------------------------------------------------------------------

internal val LANE_PALETTE_HEXES: List<String> = listOf(
    "#a78bfa", // Violet
    "#60a5fa", // Blue
    "#34d399", // Emerald
    "#fbbf24", // Amber
    "#f472b6", // Pink
    "#fb923c", // Orange
    "#2dd4bf", // Teal
    "#c084fc", // Purple
    "#f87171", // Red
    "#a3e635", // Lime
    "#22d3ee", // Cyan
    "#e879f9", // Fuchsia
)

/** Accepts `#rrggbb`, `rrggbb`, `#rrggbbaa` and `rrggbbaa`; returns packed ARGB. */
internal fun parseLaneColorArgb(raw: String?): Long? {
    val cleaned = raw?.trim()?.removePrefix("#")?.takeIf { it.isNotEmpty() } ?: return null
    if (cleaned.length != 6 && cleaned.length != 8) return null
    if (!cleaned.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
    val value = cleaned.toLongOrNull(16) ?: return null
    return if (cleaned.length == 6) value or 0xFF000000L
    else {
        // Swift parses #rrggbbaa; Compose wants aarrggbb.
        val alpha = value and 0xFFL
        ((alpha shl 24) or (value ushr 8)) and 0xFFFFFFFFL
    }
}

/** Deterministic fallback so an uncoloured lane still reads as a distinct hue. */
internal fun laneFallbackColorArgb(laneId: String): Long {
    val fallbacks = LANE_PALETTE_HEXES.take(8)
    val index = ((laneId.hashCode().toLong() and 0x7FFFFFFFL) % fallbacks.size).toInt()
    return parseLaneColorArgb(fallbacks[index])!!
}

/** `.pastel` lane surface tint — LaneComponents.swift lane card background. */
internal data class LaneTintAlphas(
    val background: Float = 0.08f,
    val border: Float = 0.14f,
    val accentBar: Float = 0.40f,
    val text: Float = 0.85f,
)

internal val LANE_TINT_ALPHAS = LaneTintAlphas()

/** Strips the ref prefixes iOS hides on the lane card branch row. */
internal fun shortBranchName(raw: String?): String? {
    val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return value
        .removePrefix("refs/heads/")
        .removePrefix("refs/remotes/origin/")
        .removePrefix("origin/")
        .takeIf { it.isNotEmpty() }
}

// ---------------------------------------------------------------------------
// Timestamps — WorkStatusAndFormattingHelpers.swift:1093-1102
// ---------------------------------------------------------------------------

internal fun relativeWorkTimestamp(iso: String?, nowMs: Long = System.currentTimeMillis()): String? {
    val instant = runCatching { iso?.let(Instant::parse) }.getOrNull() ?: return null
    val seconds = ((nowMs - instant.toEpochMilli()) / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> "now"
        seconds < 3_600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3_600}h"
        else -> "${seconds / 86_400}d"
    }
}

internal fun ageSeconds(iso: String?, nowMs: Long): Long? {
    val instant = runCatching { iso?.let(Instant::parse) }.getOrNull() ?: return null
    return ((nowMs - instant.toEpochMilli()) / 1000).coerceAtLeast(0)
}

// ---------------------------------------------------------------------------
// Preview precedence — WorkRootComponents.swift:1021-1059
// ---------------------------------------------------------------------------

internal const val WORK_PREVIEW_MAX_CHARS = 120

/**
 * attention message -> statusNote ("Done: " prefixed when settled) ->
 * chat lastOutputPreview -> session lastOutputPreview -> summary -> goal.
 * Newlines are inlined, the result is clipped, and a preview identical to the
 * title is dropped.
 */
internal fun workPreviewText(
    title: String,
    attentionMessage: String? = null,
    statusNote: String? = null,
    settled: Boolean = false,
    chatPreview: String? = null,
    sessionPreview: String? = null,
    chatSummary: String? = null,
    sessionSummary: String? = null,
    chatGoal: String? = null,
    sessionGoal: String? = null,
): String? {
    fun clean(value: String?) = value?.replace(Regex("\\s*\\R+\\s*"), " ")?.trim()?.takeIf { it.isNotEmpty() }
    val note = clean(statusNote)?.let { if (settled) "Done: $it" else it }
    val chosen = clean(attentionMessage)
        ?: note
        ?: clean(chatPreview)
        ?: clean(sessionPreview)
        ?: clean(chatSummary)
        ?: clean(sessionSummary)
        ?: clean(chatGoal)
        ?: clean(sessionGoal)
        ?: return null
    if (chosen.equals(title.trim(), ignoreCase = true)) return null
    return if (chosen.length <= WORK_PREVIEW_MAX_CHARS) chosen
    else chosen.take(WORK_PREVIEW_MAX_CHARS).trimEnd() + "…"
}

// ---------------------------------------------------------------------------
// Status semantics
// ---------------------------------------------------------------------------

internal enum class WorkRowTint { MUTED, WARNING, SUCCESS, SECONDARY }

/** WorkRootComponents.swift:1259-1414 rowTint. */
internal fun workRowTint(status: String?, archived: Boolean): WorkRowTint = when {
    archived -> WorkRowTint.WARNING
    else -> when (normalizeWorkStatus(status)) {
        "awaiting-input" -> WorkRowTint.WARNING
        "active" -> WorkRowTint.SUCCESS
        "idle" -> WorkRowTint.WARNING
        else -> WorkRowTint.SECONDARY
    }
}

/** Collapses the several wire spellings onto the canonical iOS buckets. */
internal fun normalizeWorkStatus(status: String?): String = when (status?.trim()?.lowercase()) {
    "awaiting-input", "awaiting_input", "waiting-input", "waiting", "needs_you", "needs-you" -> "awaiting-input"
    "running", "active", "starting", "streaming" -> "active"
    "idle" -> "idle"
    "failed", "error", "blocked" -> "failed"
    "done", "completed", "settled", "ended", "exited", "closed", "finished" -> "settled"
    else -> status?.trim()?.lowercase().orEmpty()
}

internal fun isSettledStatus(status: String?, settledAt: String?): Boolean =
    settledAt != null || normalizeWorkStatus(status) == "settled"

internal enum class WorkStatusCapsule { NEEDS_YOU, FAILED, STALE }

/** WorkSessionCanonicalState.swift:666-710 capsule selection. */
internal fun workStatusCapsule(
    status: String?,
    awaitingInput: Boolean,
    failed: Boolean,
    settled: Boolean,
    lastActivityAgeSeconds: Long?,
): WorkStatusCapsule? = when {
    awaitingInput || normalizeWorkStatus(status) == "awaiting-input" -> WorkStatusCapsule.NEEDS_YOU
    failed || normalizeWorkStatus(status) == "failed" -> WorkStatusCapsule.FAILED
    !settled && normalizeWorkStatus(status) == "idle" &&
        (lastActivityAgeSeconds ?: 0) >= STALE_AFTER_SECONDS -> WorkStatusCapsule.STALE
    else -> null
}

internal const val STALE_AFTER_SECONDS = 30L * 60L

internal fun workStatusCapsuleLabel(capsule: WorkStatusCapsule): String = when (capsule) {
    WorkStatusCapsule.NEEDS_YOU -> "Needs you"
    WorkStatusCapsule.FAILED -> "Failed"
    WorkStatusCapsule.STALE -> "Stale"
}

// ---------------------------------------------------------------------------
// Live pill — WorkRootComponents.swift:464-498
// ---------------------------------------------------------------------------

internal data class WorkLiveCounts(val live: Int, val waiting: Int) {
    val visible: Boolean get() = live > 0 || waiting > 0
    val attention: Boolean get() = waiting > 0
    val label: String get() = if (waiting > 0) "$waiting waiting" else "$live live"
}

internal fun workLiveCounts(cards: List<WorkCardModel>): WorkLiveCounts {
    val counted = cards.filter { !it.archived }
    return WorkLiveCounts(
        live = counted.count { normalizeWorkStatus(it.status) in LIVE_STATUSES },
        waiting = counted.count { normalizeWorkStatus(it.status) == "awaiting-input" },
    )
}

private val LIVE_STATUSES = setOf("awaiting-input", "active", "idle")

// ---------------------------------------------------------------------------
// PR badge — LaneComponents.swift:461-490
// ---------------------------------------------------------------------------

internal data class LanePrTag(val number: Int, val state: String?, val draft: Boolean = false)

internal enum class LanePrTint { SUCCESS, WARNING, DANGER, ACCENT }

internal fun lanePrBadgeLabel(tag: LanePrTag): String = when {
    tag.state?.lowercase() == "merged" -> "MERGED #${tag.number}"
    tag.state?.lowercase() == "closed" -> "CLOSED #${tag.number}"
    tag.draft || tag.state?.lowercase() == "draft" -> "DRAFT #${tag.number}"
    else -> "PR #${tag.number}"
}

internal fun lanePrTint(tag: LanePrTag): LanePrTint = when {
    tag.state?.lowercase() == "merged" -> LanePrTint.ACCENT
    tag.state?.lowercase() == "closed" -> LanePrTint.DANGER
    tag.draft || tag.state?.lowercase() == "draft" -> LanePrTint.WARNING
    else -> LanePrTint.SUCCESS
}

// ---------------------------------------------------------------------------
// Card model
// ---------------------------------------------------------------------------

internal data class LaneGitState(
    val dirty: Boolean = false,
    val ahead: Int = 0,
    val behind: Int = 0,
    val children: Int = 0,
    val linearIdentifier: String? = null,
    val pinned: Boolean = false,
)

/** Git chips for a lane, read straight off the `lanes.refreshSnapshots` payload. */
internal fun laneGitState(lane: UiLane): LaneGitState = LaneGitState(
    dirty = lane.dirty,
    ahead = lane.ahead,
    behind = lane.behind,
    children = lane.childCount,
    linearIdentifier = lane.linearIdentifier,
    pinned = false,
)

internal data class WorkCardModel(
    val id: String,
    val title: String,
    val preview: String?,
    val provider: String?,
    val providerLabel: String,
    val providerTintArgb: Long,
    val kind: SessionKind,
    val status: String?,
    val rowTint: WorkRowTint,
    val capsule: WorkStatusCapsule?,
    val timestamp: String?,
    val settled: Boolean,
    val pinned: Boolean,
    val archived: Boolean,
    val laneId: String?,
    val laneName: String?,
    val laneColorArgb: Long?,
    val laneGit: LaneGitState?,
)

/**
 * Builds the dense iOS card purely from the `work.listSessions` row and the
 * matching `lanes.refreshSnapshots` lane. The roster join the earlier revision
 * needed is gone: every field it supplied (activity timestamps, status notes,
 * attention text, pin state, lane colour) is on these two payloads already.
 *
 * Deliberately absent: `muted` and `pendingSync` — neither exists on the wire.
 */
internal fun workCardModel(
    session: UiSession,
    lane: UiLane?,
    accentArgb: Long,
    nowMs: Long = System.currentTimeMillis(),
): WorkCardModel {
    val status = session.runtimeState ?: session.status
    val settled = isSettledStatus(status, session.settledAt)
    val title = session.title
    return WorkCardModel(
        id = session.id,
        title = title,
        preview = workPreviewText(
            title = title,
            attentionMessage = session.attentionMessage,
            statusNote = session.statusNote,
            settled = settled,
            sessionPreview = session.preview,
            sessionSummary = session.summary,
            sessionGoal = session.goal,
        ),
        provider = session.provider,
        providerLabel = providerShortLabel(session.provider, session.kind),
        providerTintArgb = providerTintArgb(session.provider, accentArgb),
        kind = session.kind,
        status = status,
        rowTint = workRowTint(status, session.archived),
        capsule = workStatusCapsule(
            status = status,
            awaitingInput = session.pendingInputItemId != null || session.attentionRequestedAt != null,
            failed = session.lastTurnFailedAt != null || (session.exitCode ?: 0) > 0,
            settled = settled,
            lastActivityAgeSeconds = ageSeconds(session.lastActivityAt, nowMs),
        ),
        timestamp = relativeWorkTimestamp(session.lastActivityAt ?: session.startedAt, nowMs),
        settled = settled,
        pinned = session.pinned,
        archived = session.archived,
        laneId = session.laneId,
        laneName = lane?.name ?: session.laneName,
        laneColorArgb = lane?.let { parseLaneColorArgb(it.color) ?: laneFallbackColorArgb(it.id) },
        laneGit = lane?.let(::laneGitState),
    )
}

// ---------------------------------------------------------------------------
// Grouping — WorkSessionGrouping.swift:544-834
// ---------------------------------------------------------------------------

internal enum class WorkOrganization { BY_LANE, BY_STATUS, BY_TIME }

internal data class WorkGroup(
    val id: String,
    val label: String,
    val colorArgb: Long?,
    val cards: List<WorkCardModel>,
    val orphan: Boolean = false,
) {
    /** Every card settled/archived => the group renders dimmed and starts collapsed. */
    val quiet: Boolean get() = cards.isNotEmpty() && cards.all { it.settled || it.archived }
}

/**
 * Buckets by `laneId`, emitting lanes in roster order (primary first, then the
 * given order) and pushing sessions whose lane is unknown into a trailing
 * orphan group.
 */
internal fun groupWorkByLane(cards: List<WorkCardModel>, lanes: List<UiLane>): List<WorkGroup> {
    val ordered = lanes.sortedByDescending { it.laneType == "primary" }
    val byLane = cards.groupBy { it.laneId }
    val groups = ordered.mapNotNull { lane ->
        val bucket = byLane[lane.id]?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        WorkGroup(
            id = lane.id,
            label = lane.name,
            colorArgb = parseLaneColorArgb(lane.color) ?: laneFallbackColorArgb(lane.id),
            cards = bucket,
        )
    }
    val known = ordered.mapTo(mutableSetOf()) { it.id }
    val orphans = cards.filter { it.laneId == null || it.laneId !in known }
    return if (orphans.isEmpty()) groups else groups + orphans.groupBy { it.laneId }.map { (laneId, bucket) ->
        WorkGroup(
            id = "orphan:${laneId ?: "none"}",
            label = "Orphaned sessions: ${bucket.firstOrNull()?.laneName ?: laneId ?: "unknown lane"}",
            colorArgb = null,
            cards = bucket,
            orphan = true,
        )
    }
}

internal fun groupWorkByStatus(cards: List<WorkCardModel>): List<WorkGroup> {
    val order = listOf(
        "awaiting-input" to "Needs you",
        "active" to "Active",
        "idle" to "Idle",
        "failed" to "Failed",
        "settled" to "Done",
    )
    val buckets = cards.groupBy { normalizeWorkStatus(it.status).ifEmpty { "settled" } }
    val named = order.mapNotNull { (key, label) ->
        buckets[key]?.takeIf { it.isNotEmpty() }?.let { WorkGroup(key, label, null, it) }
    }
    val rest = buckets.filterKeys { key -> order.none { it.first == key } }.values.flatten()
    return if (rest.isEmpty()) named else named + WorkGroup("other", "Other", null, rest)
}

internal fun groupWorkByTime(cards: List<WorkCardModel>, nowMs: Long = System.currentTimeMillis()): List<WorkGroup> {
    fun bucket(card: WorkCardModel): Pair<Int, String> = when {
        card.timestamp == null -> 3 to "Older"
        card.timestamp == "now" || card.timestamp.endsWith("m") -> 0 to "Last hour"
        card.timestamp.endsWith("h") -> 1 to "Today"
        card.timestamp == "1d" -> 2 to "Yesterday"
        else -> 3 to "Older"
    }
    return cards.groupBy(::bucket).toSortedMap(compareBy { it.first }).map { (key, bucket) ->
        WorkGroup("time:${key.first}", key.second, null, bucket)
    }
}

/** Case-insensitive match over the fields iOS searches: title, lane, preview. */
internal fun matchesWorkSearch(card: WorkCardModel, query: String): Boolean {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return true
    return listOfNotNull(card.title, card.laneName, card.preview, card.providerLabel)
        .any { needle in it.lowercase() }
}
