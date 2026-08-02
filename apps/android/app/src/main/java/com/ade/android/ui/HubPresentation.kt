package com.ade.android.ui

/**
 * Pure presentation helpers for the Hub project list.
 *
 * Kept free of Compose so the pluralisation, truncation and icon-derivation
 * rules can be unit tested (see `HubPresentationTest`).
 */

/** `1 lane`, `2 lanes`, `0 lanes`. */
internal fun pluralize(count: Int, singular: String, plural: String = singular + "s"): String =
    "$count " + if (count == 1) singular else plural

/** iOS Hub subtitle: "1 lane · 3 chats". */
internal fun laneChatSummary(lanes: Int, chats: Int): String =
    pluralize(lanes, "lane") + " · " + pluralize(chats, "chat")

/**
 * Monogram fallback for projects whose catalog entry carries no `iconDataUrl`.
 *
 * The catalog (`MobileProject` in sync/model/WireModels.kt) only offers
 * `iconDataUrl`, `displayName`, `rootPath`, `repoOwner` and `repoName` — there
 * is no per-project colour or emoji field — so the fallback is derived from the
 * name. Every project previously collapsed to a single "A"; splitting on word
 * boundaries gives `ade-win-smoke-9f2` -> "AW" and `ADE` -> "AD", which are
 * actually distinguishable at a glance.
 */
internal fun projectMonogram(displayName: String): String {
    val words = displayName.split(' ', '-', '_', '.', '/', '\\')
        .map { it.trim() }
        .filter { it.isNotEmpty() && it.any(Char::isLetterOrDigit) }
    if (words.isEmpty()) return displayName.filter(Char::isLetterOrDigit).take(2).uppercase().ifEmpty { "?" }
    if (words.size == 1) {
        val word = words[0].filter(Char::isLetterOrDigit)
        return word.take(2).uppercase().ifEmpty { "?" }
    }
    val first = words[0].firstOrNull(Char::isLetterOrDigit)
    val second = words.drop(1).firstNotNullOfOrNull { word ->
        word.firstOrNull(Char::isLetter) ?: word.firstOrNull(Char::isLetterOrDigit)
    }
    return listOfNotNull(first, second).joinToString("").uppercase().ifEmpty { "?" }
}

/**
 * Deterministic tint for a monogram tile, so two projects never look identical.
 * Palette is the iOS provider-tile system-colour family.
 */
internal val projectTintPalette: List<Long> = listOf(
    0xFF0A84FFL,
    0xFF30D158L,
    0xFFFF9F0AL,
    0xFF5E5CE6L,
    0xFFFF375FL,
    0xFF40C8E0L,
    0xFFBF5AF2L,
    0xFFFFD60AL,
)

internal fun projectTintArgb(projectId: String): Long {
    var hash = 2166136261L
    for (char in projectId) {
        hash = (hash xor char.code.toLong()) * 16777619L and 0xFFFFFFFFL
    }
    return projectTintPalette[(hash % projectTintPalette.size).toInt()]
}

/**
 * Lane colours arrive from the host tuned for ADE's dark desktop UI. On a light
 * Hub the bright yellows and greens (e.g. `#F59E0B`) drop well under 3:1 against
 * the near-white card, so they are darkened until they clear the bar. Dark mode
 * is left untouched.
 */
internal fun readableOnLightArgb(argb: Long, isDark: Boolean, maxLuminance: Double = 0.34): Long {
    if (isDark) return argb
    val alpha = argb and 0xFF000000L
    var r = ((argb shr 16) and 0xFF).toDouble()
    var g = ((argb shr 8) and 0xFF).toDouble()
    var b = (argb and 0xFF).toDouble()
    fun luminance() = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    val current = luminance()
    if (current <= maxLuminance) return argb
    val scale = maxLuminance / current
    r *= scale
    g *= scale
    b *= scale
    return alpha or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()
}
