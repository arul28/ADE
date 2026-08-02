package com.ade.android.ui

/**
 * Pure, framework-free chat transcript presentation logic.
 *
 * Nothing in this file may import Compose or Android — it is unit-tested on the
 * plain JVM, mirroring how [WorkPresentation] is structured. Colours are packed
 * ARGB longs rather than Compose `Color`.
 *
 * Ported from the iOS sources, which are the visual spec:
 *   - apps/ios/ADE/Views/Work/WorkMarkdownParsing.swift
 *   - apps/ios/ADE/Views/Work/WorkChatHeaderAndMessageViews.swift
 *   - apps/ios/ADE/Views/Work/WorkChatRichCardViews.swift
 *   - apps/ios/ADE/Views/Work/WorkChatComposerAndInputViews.swift
 *   - apps/ios/ADE/Views/Work/WorkModelPickerSheet.swift
 *   - apps/ios/ADE/Views/Components/ADEDesignSystem.swift
 *
 * Nothing here may log or persist session content.
 */

// ---------------------------------------------------------------------------
// Colour maths — ADEDesignSystem.swift:330-372, WorkChatHeaderAndMessageViews.swift:603-620
// ---------------------------------------------------------------------------

private const val OPAQUE = 0xFF000000L

/**
 * Linear sRGB blend. [fraction] is the weight of [other] (0 → all [base]),
 * matching CSS `color-mix` semantics and `workMixColors`. Alpha is taken from
 * [base] — every ADE call site mixes two opaque colours.
 */
internal fun mixArgb(base: Long, other: Long, fraction: Double): Long {
    val t = fraction.coerceIn(0.0, 1.0)
    fun channel(shift: Int): Long {
        val a = (base ushr shift) and 0xFFL
        val b = (other ushr shift) and 0xFFL
        return (a + (b - a) * t).toLong().coerceIn(0L, 255L)
    }
    val alpha = (base ushr 24) and 0xFFL
    return (alpha shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
}

/** Replaces the alpha channel with [alpha] in 0…1. */
internal fun withAlpha(argb: Long, alpha: Float): Long =
    (Math.round(alpha.coerceIn(0f, 1f) * 255f).toLong() shl 24) or (argb and 0x00FFFFFFL)

/** ADEDesignSystem.swift `providerChatAccents` + the neutral grey fallback. */
internal fun chatSurfaceAccentArgb(provider: String?, modelId: String? = null): Long {
    val key = provider?.trim()?.lowercase().orEmpty()
    PROVIDER_CHAT_ACCENTS[key]?.let { return it }
    val model = modelId?.trim()?.lowercase().orEmpty()
    return when {
        model.startsWith("claude") -> PROVIDER_CHAT_ACCENTS.getValue("claude")
        model.startsWith("gpt-") || model.contains("codex") -> PROVIDER_CHAT_ACCENTS.getValue("codex")
        model.startsWith("gemini") -> PROVIDER_CHAT_ACCENTS.getValue("google")
        else -> OPAQUE or 0x71717AL
    }
}

private val PROVIDER_CHAT_ACCENTS: Map<String, Long> = mapOf(
    "claude" to (OPAQUE or 0xD97706L),
    "anthropic" to (OPAQUE or 0xD97706L),
    "codex" to (OPAQUE or 0xE7E5E4L),
    "openai" to (OPAQUE or 0xE7E5E4L),
    "cursor" to (OPAQUE or 0xA78BFAL),
    "opencode" to (OPAQUE or 0x2563EBL),
    "google" to (OPAQUE or 0xF59E0BL),
    "gemini" to (OPAQUE or 0xF59E0BL),
    "mistral" to (OPAQUE or 0xF97316L),
    "deepseek" to (OPAQUE or 0x3B82F6L),
    "xai" to (OPAQUE or 0xDC2626L),
    "grok" to (OPAQUE or 0xDC2626L),
    "groq" to (OPAQUE or 0x06B6D4L),
)

internal const val WORK_VIOLET_ARGB = OPAQUE or 0x7C3AEDL

/** WorkChatHeaderAndMessageViews.swift:327-338. */
internal fun isCodexChat(provider: String?, modelId: String?): Boolean {
    val p = provider?.trim()?.lowercase().orEmpty()
    val m = modelId?.trim()?.lowercase().orEmpty()
    return p == "codex" || p == "openai" || m.contains("codex") ||
        m.startsWith("gpt-") || m.startsWith("openai/gpt-")
}

/** The terracotta user bubble fill. Computed per provider — never a literal. */
internal fun userBubbleFillArgb(provider: String?, modelId: String? = null): Long {
    val accent = chatSurfaceAccentArgb(provider, modelId)
    val t = if (isCodexChat(provider, modelId)) 0.44 else 0.36
    return mixArgb(accent, WORK_VIOLET_ARGB, t)
}

/** accent mixed 14% toward white, then dropped to 45% alpha. */
internal fun userBubbleBorderArgb(provider: String?, modelId: String? = null): Long =
    withAlpha(mixArgb(chatSurfaceAccentArgb(provider, modelId), OPAQUE or 0xFFFFFFL, 0.14), 0.45f)

// ---------------------------------------------------------------------------
// Monospaced whole-message fallback — WorkMarkdownParsing.swift:7-54
// ---------------------------------------------------------------------------

internal val WIREFRAME_GLYPHS: Set<Char> = setOf(
    '│', '┌', '┐', '└', '┘', '├', '┤', '┼', '─',
    '╭', '╮', '╰', '╯', '║', '═', '╔', '╗', '╚', '╝', '╠', '╣', '╬',
    '▌', '▐', '█', '▓', '▒', '░', '▢', '▣', '□', '■',
)

/** True when a line has an interior run of 3+ spaces/tabs between non-whitespace. */
internal fun lineHasAlignedColumnGap(line: CharSequence): Boolean {
    var sawNonWhitespace = false
    var whitespaceRun = 0
    for (character in line) {
        if (character == ' ' || character == '\t') {
            if (sawNonWhitespace) whitespaceRun += 1
        } else {
            if (whitespaceRun >= 3) return true
            sawNonWhitespace = true
            whitespaceRun = 0
        }
    }
    return false
}

/** Whether the whole answer renders as one fixed-column monospaced block. */
internal fun assistantMessageUsesMonospacedPreview(text: String): Boolean {
    var insideFence = false
    var proseLineCount = 0
    var alignedColumnLineCount = 0
    for (rawLine in text.split("\n")) {
        val trimmed = rawLine.trim(' ', '\t')
        if (trimmed.startsWith("```")) {
            insideFence = !insideFence
            continue
        }
        if (insideFence || trimmed.isEmpty()) continue
        if (trimmed.any(WIREFRAME_GLYPHS::contains)) return true
        proseLineCount += 1
        if (trimmed.contains('|')) continue
        if (lineHasAlignedColumnGap(trimmed)) alignedColumnLineCount += 1
    }
    return alignedColumnLineCount >= 2 && alignedColumnLineCount * 2 >= proseLineCount
}

// ---------------------------------------------------------------------------
// Markdown blocks — WorkMarkdownParsing.swift:56-373
// ---------------------------------------------------------------------------

internal sealed interface MarkdownBlockKind {
    data class Paragraph(val text: String) : MarkdownBlockKind
    data class Heading(val level: Int, val text: String) : MarkdownBlockKind
    data class UnorderedList(val items: List<String>) : MarkdownBlockKind
    data class OrderedList(val start: Int, val items: List<String>) : MarkdownBlockKind
    data class Blockquote(val lines: List<String>) : MarkdownBlockKind
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MarkdownBlockKind
    data class Code(val language: String?, val code: String) : MarkdownBlockKind
    data object Rule : MarkdownBlockKind

    val cacheKey: String
        get() = when (this) {
            is Paragraph -> "paragraph|$text"
            is Heading -> "heading|$level|$text"
            is UnorderedList -> "unorderedList|${items.joinToString("")}"
            is OrderedList -> "orderedList|$start|${items.joinToString("")}"
            is Blockquote -> "blockquote|${lines.joinToString("")}"
            is Table -> "table|${headers.joinToString("")}|" +
                rows.joinToString("") { it.joinToString("") }
            is Code -> "code|${language.orEmpty()}|$code"
            Rule -> "rule"
        }
}

internal data class MarkdownBlock(val id: String, val kind: MarkdownBlockKind)

/** FNV-1a 64, lowercase hex — matches `workStableDigest`. */
internal fun stableDigest(value: String): String {
    var hash = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        hash = hash xor (byte.toLong() and 0xFFL)
        hash *= 0x100000001b3L
    }
    return hash.toULong().toString(16)
}

private val UNORDERED_ITEM = Regex("""^[-*+]\s+""")
private val ORDERED_ITEM = Regex("""^(\d+)\.\s+""")
private val RULES = setOf("---", "***", "___")

internal fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
    val lines = markdown.replace("\r\n", "\n").split("\n")
    val blocks = mutableListOf<MarkdownBlock>()

    fun append(kind: MarkdownBlockKind) {
        blocks.add(MarkdownBlock("markdown-block-${blocks.size}-${stableDigest(kind.cacheKey)}", kind))
    }

    fun appendParagraph(paragraph: List<String>) {
        val text = paragraph.joinToString("\n").trim()
        if (text.isNotEmpty()) append(MarkdownBlockKind.Paragraph(text))
    }

    var index = 0
    while (index < lines.size) {
        val trimmed = lines[index].trim(' ', '\t')

        if (trimmed.isEmpty()) {
            index += 1
            continue
        }

        if (trimmed.startsWith("```")) {
            val language = trimmed.drop(3).trim().takeIf(String::isNotEmpty)
            index += 1
            val code = mutableListOf<String>()
            while (index < lines.size && !lines[index].trim(' ', '\t').startsWith("```")) {
                code.add(lines[index])
                index += 1
            }
            if (index < lines.size) index += 1
            append(MarkdownBlockKind.Code(language, code.joinToString("\n")))
            continue
        }

        val hashCount = trimmed.takeWhile { it == '#' }.length
        if (hashCount in 1..trimmed.lastIndex) {
            append(MarkdownBlockKind.Heading(hashCount, trimmed.drop(hashCount).trim(' ', '\t')))
            index += 1
            continue
        }

        if (trimmed in RULES) {
            append(MarkdownBlockKind.Rule)
            index += 1
            continue
        }

        if (trimmed.startsWith(">")) {
            val quote = mutableListOf<String>()
            while (index < lines.size) {
                val value = lines[index].trim(' ', '\t')
                if (!value.startsWith(">")) break
                quote.add(value.drop(1).trim(' ', '\t'))
                index += 1
            }
            append(MarkdownBlockKind.Blockquote(quote))
            continue
        }

        if (isMarkdownTableHeader(lines, index)) {
            val headers = splitMarkdownTableRow(lines[index])
            index += 2
            val rows = mutableListOf<List<String>>()
            while (index < lines.size && lines[index].contains('|')) {
                rows.add(splitMarkdownTableRow(lines[index]))
                index += 1
            }
            append(MarkdownBlockKind.Table(headers, rows))
            continue
        }

        val unordered = parseListAt(lines, index, ordered = false)
        if (unordered != null) {
            append(MarkdownBlockKind.UnorderedList(unordered.items))
            index = unordered.nextIndex
            continue
        }

        val ordered = parseListAt(lines, index, ordered = true)
        if (ordered != null) {
            append(MarkdownBlockKind.OrderedList(ordered.startNumber ?: 1, ordered.items))
            index = ordered.nextIndex
            continue
        }

        val paragraph = mutableListOf<String>()
        while (index < lines.size) {
            val value = lines[index].trim(' ', '\t')
            if (value.isEmpty() || value.startsWith("```") || value.startsWith(">") ||
                isMarkdownTableHeader(lines, index) ||
                UNORDERED_ITEM.containsMatchIn(value) || ORDERED_ITEM.containsMatchIn(value) ||
                value in RULES
            ) break
            // Only break for REAL headings. A line of only '#' is not a heading,
            // and breaking on it would leave `index` unadvanced and spin forever
            // — streaming snapshots routinely end mid-heading.
            if (value.startsWith("#") && value.any { it != '#' }) break
            paragraph.add(lines[index])
            index += 1
        }
        if (paragraph.isEmpty()) {
            // Defensive: never fail to advance.
            index += 1
        } else {
            appendParagraph(paragraph)
        }
    }
    return blocks
}

private data class ParsedList(val items: List<String>, val nextIndex: Int, val startNumber: Int?)

private fun parseListAt(lines: List<String>, index: Int, ordered: Boolean): ParsedList? {
    if (index >= lines.size) return null
    val regex = if (ordered) ORDERED_ITEM else UNORDERED_ITEM
    var cursor = index
    val items = mutableListOf<String>()
    var startNumber: Int? = null
    while (cursor < lines.size) {
        val line = lines[cursor].trim(' ', '\t')
        val match = regex.find(line) ?: break
        if (ordered && startNumber == null) startNumber = match.groupValues[1].toIntOrNull()
        items.add(markdownListItemText(line.substring(match.value.length)))
        cursor += 1
    }
    return if (items.isEmpty()) null else ParsedList(items, cursor, startNumber)
}

/** GFM task lists render as glyphs rather than leaking literal `[ ]` / `[x]`. */
internal fun markdownListItemText(text: String): String = when {
    text.startsWith("[ ] ") -> "☐ " + text.drop(4)
    text.startsWith("[x] ") || text.startsWith("[X] ") -> "☑ " + text.drop(4)
    else -> text
}

internal fun isMarkdownTableHeader(lines: List<String>, index: Int): Boolean {
    if (index + 1 >= lines.size) return false
    val header = lines[index]
    val separator = lines[index + 1].trim(' ', '\t')
    return header.contains('|') && separator.contains('|') &&
        separator.replace("|", "").all { it == '-' || it == ':' || it == ' ' }
}

internal fun splitMarkdownTableRow(row: String): List<String> {
    val cells = row.split("|").map { it.trim(' ', '\t') }.toMutableList()
    if (cells.firstOrNull() == "") cells.removeAt(0)
    if (cells.lastOrNull() == "") cells.removeAt(cells.lastIndex)
    return cells
}

// ---------------------------------------------------------------------------
// Streaming tail parse — WorkMarkdownParsing.swift:105-190
// ---------------------------------------------------------------------------

/**
 * Per-message streaming parse state. Splits the text at the last blank line
 * that is not inside an open ``` fence; everything before that boundary can
 * never be reinterpreted by later text, so it is parsed once and cached while
 * only the small growing tail re-parses per delta.
 *
 * The combined output is byte-identical to [parseMarkdownBlocks] over the whole
 * text — same kinds, same ids.
 */
internal class StreamingMarkdownParser {
    private var prefixText: String = ""
    private var prefixBlocks: List<MarkdownBlock> = emptyList()
    private var fullText: String? = null
    private var blocks: List<MarkdownBlock> = emptyList()

    fun parse(markdown: String): List<MarkdownBlock> {
        val normalized = markdown.replace("\r\n", "\n")
        if (fullText == normalized) return blocks

        val boundary = stableBoundaryIndex(normalized)
        if (boundary == null) {
            val parsed = parseMarkdownBlocks(normalized)
            prefixText = ""
            prefixBlocks = emptyList()
            fullText = normalized
            blocks = parsed
            return parsed
        }

        val prefix = normalized.substring(0, boundary)
        val resolvedPrefixBlocks =
            if (prefixText == prefix) prefixBlocks else parseMarkdownBlocks(prefix)
        val tailBlocks = parseMarkdownBlocks(normalized.substring(boundary))
        val combined = ArrayList<MarkdownBlock>(resolvedPrefixBlocks.size + tailBlocks.size)
        combined.addAll(resolvedPrefixBlocks)
        for (block in tailBlocks) {
            // Re-id so indices continue from the prefix — the parser bakes the
            // running block index into each id.
            combined.add(
                MarkdownBlock("markdown-block-${combined.size}-${stableDigest(block.kind.cacheKey)}", block.kind),
            )
        }
        prefixText = prefix
        prefixBlocks = resolvedPrefixBlocks
        fullText = normalized
        blocks = combined
        return combined
    }
}

/**
 * Index just past the last empty line that is not inside an unclosed fence.
 * Fence state toggles on every line whose trimmed text starts with "```",
 * mirroring the parser's open/close rule.
 */
internal fun stableBoundaryIndex(normalized: String): Int? {
    var boundary: Int? = null
    var insideFence = false
    var lineStart = 0
    while (lineStart <= normalized.length) {
        val newlineIndex = normalized.indexOf('\n', lineStart).takeIf { it >= 0 }
        val lineEnd = newlineIndex ?: normalized.length
        if (lineStart == lineEnd) {
            if (!insideFence) boundary = newlineIndex?.plus(1) ?: lineEnd
        } else if (normalized.substring(lineStart, lineEnd).trim(' ', '\t').startsWith("```")) {
            insideFence = !insideFence
        }
        if (newlineIndex == null) break
        lineStart = newlineIndex + 1
    }
    return boundary
}

// ---------------------------------------------------------------------------
// Assistant truncation — WorkChatHeaderAndMessageViews.swift:625-940
// ---------------------------------------------------------------------------

internal const val ASSISTANT_INITIAL_LINE_BUDGET = 48
internal const val ASSISTANT_LINE_BUDGET_STEP = 48
internal const val ASSISTANT_INITIAL_CHARACTER_BUDGET = 1_600
internal const val ASSISTANT_CHARACTER_BUDGET_STEP = 2_400
internal const val ASSISTANT_EXPANDED_CHARACTERS_PER_LINE = 96
internal const val ASSISTANT_SMALL_FULL_CHARACTER_BUDGET = 6_000
internal const val ASSISTANT_WIDE_INITIAL_LINE_BUDGET = 24
internal const val ASSISTANT_WIDE_LINE_BUDGET_STEP = 24

internal data class AssistantPreview(
    val text: String,
    val truncated: Boolean,
    val usesMonospacedRendering: Boolean,
    val visibleLineCount: Int,
    val totalLineCount: Int,
    val visibleCharacterCount: Int,
    val totalCharacterCount: Int,
)

internal fun assistantEffectiveLineBudget(requested: Int, wide: Boolean): Int {
    if (!wide) return requested
    if (requested <= ASSISTANT_INITIAL_LINE_BUDGET) {
        return minOf(requested, ASSISTANT_WIDE_INITIAL_LINE_BUDGET)
    }
    val steps = (requested - ASSISTANT_INITIAL_LINE_BUDGET) / ASSISTANT_LINE_BUDGET_STEP
    return ASSISTANT_WIDE_INITIAL_LINE_BUDGET + steps * ASSISTANT_WIDE_LINE_BUDGET_STEP
}

internal fun assistantCharacterBudget(lineBudget: Int): Int {
    val extraSteps = ((lineBudget - ASSISTANT_INITIAL_LINE_BUDGET) / ASSISTANT_LINE_BUDGET_STEP).coerceAtLeast(0)
    val stepped = ASSISTANT_INITIAL_CHARACTER_BUDGET + extraSteps * ASSISTANT_CHARACTER_BUDGET_STEP
    if (extraSteps == 0) return stepped
    return maxOf(stepped, lineBudget * ASSISTANT_EXPANDED_CHARACTERS_PER_LINE)
}

private fun assistantWideCharacterBudget(lineBudget: Int): Int {
    val extraSteps =
        ((lineBudget - ASSISTANT_WIDE_INITIAL_LINE_BUDGET) / ASSISTANT_WIDE_LINE_BUDGET_STEP).coerceAtLeast(0)
    val stepped = ASSISTANT_INITIAL_CHARACTER_BUDGET + extraSteps * ASSISTANT_CHARACTER_BUDGET_STEP
    return maxOf(stepped, lineBudget * ASSISTANT_EXPANDED_CHARACTERS_PER_LINE)
}

/** Head-anchored bounded preview. `lineBudget` grows by a step per "Show more". */
/**
 * Reconcile a newly arrived `text` event against what the message already holds.
 *
 * The host streams assistant text as **incremental deltas** that all share one
 * `messageId` — `"1\n2\n3\n"`, `"4\n5"`, `"\n6\n7\n8"`. Replacing the body on
 * each event (which this fold used to do) made the message show only the newest
 * delta: a few tokens at a time, then apparently freezing on the final chunk
 * when the stream ended. So deltas must be concatenated.
 *
 * Not every source is a delta, though: canonical transcript replays and some
 * providers re-send the whole message so far. Both shapes are handled without a
 * per-provider flag:
 *  - [incoming] already contains everything we have → it is a cumulative
 *    snapshot, take it verbatim.
 *  - we already end with [incoming] → a duplicate/replayed chunk, ignore it.
 *  - otherwise → a genuine delta, append it.
 */
internal fun mergeAssistantText(existing: String, incoming: String): String = when {
    existing.isEmpty() -> incoming
    incoming.isEmpty() -> existing
    incoming.length >= existing.length && incoming.startsWith(existing) -> incoming
    existing.endsWith(incoming) -> existing
    else -> existing + incoming
}

internal fun assistantMessagePreview(
    markdown: String,
    lineBudget: Int = ASSISTANT_INITIAL_LINE_BUDGET,
    characterBudget: Int = assistantCharacterBudget(lineBudget),
    classification: Boolean? = null,
): AssistantPreview {
    val normalized = markdown.replace("\r\n", "\n")
    if (normalized.isEmpty()) {
        return AssistantPreview(markdown, false, false, 0, 0, 0, 0)
    }
    val wide = classification ?: assistantMessageUsesMonospacedPreview(normalized)
    val clampedLines = assistantEffectiveLineBudget(lineBudget.coerceAtLeast(1), wide)
    val clampedChars = maxOf(
        if (wide) maxOf(characterBudget, assistantWideCharacterBudget(clampedLines)) else characterBudget,
        256,
    )
    val totalLines = normalized.count { it == '\n' } + 1
    val totalChars = normalized.length
    if (totalLines <= clampedLines && totalChars <= maxOf(clampedChars, ASSISTANT_SMALL_FULL_CHARACTER_BUDGET)) {
        return AssistantPreview(markdown, false, wide, totalLines, totalLines, totalChars, totalChars)
    }

    val rendered = StringBuilder()
    var usedCharacters = 0
    var visibleLines = 0
    var lineStart = 0
    while (lineStart <= normalized.length && visibleLines < clampedLines) {
        val lineEnd = normalized.indexOf('\n', lineStart).takeIf { it >= 0 } ?: normalized.length
        val newlineCost = if (visibleLines == 0) 0 else 1
        val remaining = clampedChars - usedCharacters - newlineCost
        if (remaining <= 0) break
        if (visibleLines > 0) {
            rendered.append('\n')
            usedCharacters += 1
        }
        val lineLength = lineEnd - lineStart
        if (lineLength > remaining) {
            rendered.append(normalized, lineStart, lineStart + remaining)
            visibleLines += 1
            break
        }
        rendered.append(normalized, lineStart, lineEnd)
        usedCharacters += lineLength
        visibleLines += 1
        if (lineEnd >= normalized.length) break
        lineStart = lineEnd + 1
    }
    return AssistantPreview(
        text = rendered.toString(),
        truncated = visibleLines < totalLines || rendered.length < normalized.length,
        usesMonospacedRendering = wide,
        visibleLineCount = visibleLines,
        totalLineCount = totalLines,
        visibleCharacterCount = rendered.length,
        totalCharacterCount = totalChars,
    )
}

internal fun assistantPreviewSummary(preview: AssistantPreview): String =
    "${preview.visibleLineCount} of ${preview.totalLineCount} lines"

// ---------------------------------------------------------------------------
// Count / cost / effort formatting — WorkChatComposerAndInputViews.swift:63-111
// ---------------------------------------------------------------------------

internal fun abbreviateCount(count: Long): String = when {
    count < 1_000L -> count.toString()
    count < 1_000_000L -> abbreviation(count / 1_000.0, "k")
    count < 1_000_000_000L -> abbreviation(count / 1_000_000.0, "M")
    else -> abbreviation(count / 1_000_000_000.0, "B")
}

private fun abbreviation(value: Double, suffix: String): String {
    val rounded = Math.round(value * 10) / 10.0
    if (rounded % 1.0 == 0.0) return "${rounded.toLong()}$suffix"
    return String.format(java.util.Locale.US, "%.1f%s", rounded, suffix)
}

/** Two decimals above one cent, four below — mirrors desktop. */
internal fun formatUsageCost(cost: Double): String =
    if (cost >= 0.01) String.format(java.util.Locale.US, "$%.2f", cost)
    else String.format(java.util.Locale.US, "$%.4f", cost)

internal fun reasoningEffortAbbreviation(effort: String): String =
    when (val lower = effort.trim().lowercase()) {
        "minimal" -> "MIN"
        "low" -> "LOW"
        "medium" -> "MED"
        "high" -> "HI"
        "xhigh", "extra-high", "extra_high", "extra high" -> "XH"
        "max" -> "MAX"
        "ultra", "ultracode" -> "ULTRA"
        else -> lower.take(3).uppercase()
    }

internal fun reasoningEffortDisplayName(effort: String): String =
    when (effort.trim().lowercase()) {
        "minimal" -> "Minimal"
        "low" -> "Light"
        "medium" -> "Medium"
        "high" -> "High"
        "xhigh", "extra-high", "extra_high", "extra high" -> "Extra High"
        "max" -> "Max"
        "ultra" -> "Ultra"
        "ultracode" -> "Ultracode"
        else -> effort.trim().replaceFirstChar(Char::uppercase)
    }

// ---------------------------------------------------------------------------
// Subagent identicon — WorkChatRichCardViews.swift:3432-3475
// ---------------------------------------------------------------------------

/** djb2 over UTF-16 scalars, wrapping like Swift's `&+`/`&<<`. */
internal fun stableSubagentHash(value: String): Long {
    var hash = 5381L
    var index = 0
    while (index < value.length) {
        val scalar = value.codePointAt(index)
        hash = (hash shl 5) + hash + scalar.toLong()
        index += Character.charCount(scalar)
    }
    return hash
}

/** Palette index over [accent, success, warning, info, danger]. */
internal fun subagentGlyphColorIndex(agentId: String, paletteSize: Int = 5): Int =
    (stableSubagentHash(agentId).toULong() % paletteSize.toULong()).toInt()

/**
 * Deterministic 3x3 bit grid.
 *
 * **Intentional divergence from the Swift original** (`WorkChatRichCardViews.swift`).
 * iOS derives each cell from `djb2("<agentId>:<index>") % 3 != 0`. djb2 multiplies
 * by 33, which is itself divisible by 3, so every character except the last
 * contributes a multiple of 3 to the hash and `hash % 3` collapses to the residue
 * of the trailing character — the index digit. Every agent id therefore produces
 * the *same* nine cells and subagents are distinguishable only by colour.
 *
 * Android instead runs the djb2 seed through a SplitMix64-style avalanche per
 * cell and takes a high bit, so shapes genuinely vary across agent ids. Colour
 * selection ([subagentGlyphColorIndex]) is unchanged and still matches iOS.
 */
internal fun subagentGlyphBit(agentId: String, index: Int): Boolean =
    (avalanche(stableSubagentHash(agentId) * 0x9E3779B97F4A7C15uL.toLong() + index * 0x1000193L) ushr 61) and 1L == 1L

/** SplitMix64 finalizer — mixes every input bit into every output bit. */
private fun avalanche(value: Long): Long {
    var x = value
    x = (x xor (x ushr 30)) * -0x40A7B892E31B1A47L // 0xBF58476D1CE4E5B9
    x = (x xor (x ushr 27)) * -0x6B2FB644ECCEEE15L // 0x94D049BB133111EB
    return x xor (x ushr 31)
}

internal enum class SubagentStatus { RUNNING, SUCCEEDED, FAILED, STOPPED }

internal fun subagentStatusLabel(status: SubagentStatus): String = when (status) {
    SubagentStatus.RUNNING -> "Running"
    SubagentStatus.SUCCEEDED -> "Completed"
    SubagentStatus.FAILED -> "Failed"
    SubagentStatus.STOPPED -> "Stopped"
}

internal fun parseSubagentStatus(raw: String?): SubagentStatus =
    when (raw?.trim()?.lowercase()) {
        "completed", "succeeded", "success", "done", "ok" -> SubagentStatus.SUCCEEDED
        "failed", "error" -> SubagentStatus.FAILED
        "stopped", "cancelled", "canceled", "interrupted" -> SubagentStatus.STOPPED
        else -> SubagentStatus.RUNNING
    }

// ---------------------------------------------------------------------------
// Context ring
// ---------------------------------------------------------------------------

internal enum class ContextRingTone { OK, WARNING, DANGER, UNKNOWN }

/** Cyan-blue below 70% — deliberately NOT the accent. */
internal const val CONTEXT_RING_OK_ARGB = OPAQUE or 0x38BCF7L

internal data class ContextRingState(
    val ratio: Double?,
    val tone: ContextRingTone,
    val label: String,
    val busy: Boolean = false,
) {
    val visible: Boolean get() = ratio != null || tone == ContextRingTone.UNKNOWN
}

/**
 * [state] is the wire `context_usage.state` — "compacting"/"recalculating"
 * render an ellipsis instead of a stale number. A null [ratio] renders the
 * honest unknown "?" state; never invent a value.
 */
internal fun contextRingState(ratio: Double?, state: String? = null): ContextRingState {
    val normalizedState = state?.trim()?.lowercase()
    if (normalizedState == "compacting" || normalizedState == "recalculating") {
        return ContextRingState(ratio, ContextRingTone.UNKNOWN, "…", busy = true)
    }
    if (ratio == null) return ContextRingState(null, ContextRingTone.UNKNOWN, "?")
    val clamped = ratio.coerceAtLeast(0.0)
    val tone = when {
        clamped >= 0.90 -> ContextRingTone.DANGER
        clamped >= 0.70 -> ContextRingTone.WARNING
        else -> ContextRingTone.OK
    }
    return ContextRingState(clamped, tone, "${Math.round(clamped * 100)}")
}

// ---------------------------------------------------------------------------
// Transcript folding
// ---------------------------------------------------------------------------

internal enum class ToolCallStatus { RUNNING, COMPLETED, FAILED }

internal fun parseToolStatus(raw: String?): ToolCallStatus = when (raw?.trim()?.lowercase()) {
    "completed", "success", "succeeded", "ok", "done" -> ToolCallStatus.COMPLETED
    "failed", "error", "denied", "rejected" -> ToolCallStatus.FAILED
    else -> ToolCallStatus.RUNNING
}

internal data class ChatToolCall(
    val itemId: String,
    val tool: String,
    /** The short slug shown in mono ("Read", "bash"). */
    val slug: String,
    /** The truncated target ("src/main.kt", the command line). */
    val target: String?,
    val detail: String?,
    val status: ToolCallStatus,
)

internal enum class FileChangeKind { CREATE, MODIFY, DELETE, RENAME }

internal fun fileChangeKindLabel(kind: FileChangeKind): String? = when (kind) {
    FileChangeKind.CREATE -> "Created"
    FileChangeKind.DELETE -> "Deleted"
    FileChangeKind.RENAME -> "Renamed"
    FileChangeKind.MODIFY -> null
}

internal fun parseFileChangeKind(raw: String?): FileChangeKind = when (raw?.trim()?.lowercase()) {
    "create", "created", "add", "added" -> FileChangeKind.CREATE
    "delete", "deleted", "remove", "removed" -> FileChangeKind.DELETE
    "rename", "renamed" -> FileChangeKind.RENAME
    else -> FileChangeKind.MODIFY
}

internal data class ChatFileChange(
    val itemId: String,
    val path: String,
    val kind: FileChangeKind,
    val diff: String,
    val additions: Int,
    val deletions: Int,
) {
    val extension: String
        get() = path.substringAfterLast('/').substringAfterLast('.', "").take(4).uppercase()
}

/** Counts `+`/`-` lines, ignoring the `+++`/`---` file headers. */
internal fun diffCounts(diff: String): Pair<Int, Int> {
    var additions = 0
    var deletions = 0
    for (line in diff.split("\n")) {
        when {
            line.startsWith("+++") || line.startsWith("---") -> Unit
            line.startsWith("+") -> additions += 1
            line.startsWith("-") -> deletions += 1
        }
    }
    return additions to deletions
}

internal enum class DiffLineTone { ADDITION, DELETION, HUNK, CONTEXT }

internal fun diffLineTone(line: String): DiffLineTone = when {
    line.startsWith("@@") -> DiffLineTone.HUNK
    line.startsWith("+++") || line.startsWith("---") -> DiffLineTone.CONTEXT
    line.startsWith("+") -> DiffLineTone.ADDITION
    line.startsWith("-") -> DiffLineTone.DELETION
    else -> DiffLineTone.CONTEXT
}

internal data class ChatSubagent(
    val taskId: String,
    val agentId: String,
    val name: String,
    val agentType: String?,
    val status: SubagentStatus,
    val summary: String?,
    val durationLabel: String?,
)

internal data class ChatUsageSummary(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheCreationTokens: Long = 0,
    val costUsd: Double = 0.0,
) {
    val isEmpty: Boolean get() = inputTokens == 0L && outputTokens == 0L && costUsd <= 0.0
}

/**
 * Wire values of the host's `AgentChatApprovalDecision`
 * (apps/desktop/src/shared/types/chat.ts) as accepted by `chat.approve`.
 */
internal enum class ApprovalDecision(val wire: String) {
    ACCEPT("accept"),
    ACCEPT_FOR_SESSION("accept_for_session"),
    DECLINE("decline"),
}

internal data class ChatApproval(
    val itemId: String,
    val kind: String,
    val description: String,
    val provider: String?,
    /** Plan approvals swap the verbs to Approve/Reject and add inline feedback. */
    val plan: Boolean,
)

internal sealed interface ChatTimelineItem {
    val id: String

    data class TurnStart(
        override val id: String,
        val timestampIso: String?,
        val provider: String?,
    ) : ChatTimelineItem

    data class UserMessage(
        override val id: String,
        val text: String,
        val provider: String?,
        val modelId: String?,
    ) : ChatTimelineItem

    data class AssistantMessage(
        override val id: String,
        val text: String,
        val streaming: Boolean,
    ) : ChatTimelineItem

    data class ToolGroup(
        override val id: String,
        val calls: List<ChatToolCall>,
    ) : ChatTimelineItem

    data class FilesChanged(
        override val id: String,
        val files: List<ChatFileChange>,
    ) : ChatTimelineItem {
        val additions: Int get() = files.sumOf(ChatFileChange::additions)
        val deletions: Int get() = files.sumOf(ChatFileChange::deletions)
    }

    data class Subagent(
        override val id: String,
        val snapshot: ChatSubagent,
    ) : ChatTimelineItem

    data class Usage(
        override val id: String,
        val summary: ChatUsageSummary,
    ) : ChatTimelineItem

    data class TurnEnd(
        override val id: String,
        val timestampIso: String?,
        val durationMs: Long?,
        val hadTools: Boolean,
    ) : ChatTimelineItem

    data class Notice(
        override val id: String,
        val message: String,
        val failure: Boolean,
    ) : ChatTimelineItem
}

/**
 * Everything the transcript surface needs, folded from the raw event stream.
 *
 * Note the thin-client caveat: subagent rosters and tool groups accumulate over
 * the events this client has actually seen. A session that has not paged in
 * early history WILL show incomplete counts — render what is here, never
 * fabricate the rest.
 */
/** Placeholder while the real fold is computed off the main thread. */
internal val EMPTY_CHAT_TRANSCRIPT = ChatTranscript()

internal data class ChatTranscript(
    val items: List<ChatTimelineItem> = emptyList(),
    val pendingApprovals: List<ChatApproval> = emptyList(),
    val contextRatio: Double? = null,
    val contextState: String? = null,
    val turnLive: Boolean = false,
    val latestModelId: String? = null,
) {
    val contextRing: ContextRingState get() = contextRingState(contextRatio, contextState)
}

/**
 * A minimal, JSON-library-free view of one wire event, so the fold stays pure.
 * [ChatEventAdapter] in the Compose layer converts `JsonObject` into this.
 */
internal data class ChatEvent(
    val type: String,
    val timestampIso: String? = null,
    val turnId: String? = null,
    val itemId: String? = null,
    val messageId: String? = null,
    val text: String? = null,
    val tool: String? = null,
    val argsText: String? = null,
    val resultText: String? = null,
    val status: String? = null,
    val path: String? = null,
    val diff: String? = null,
    val kind: String? = null,
    val description: String? = null,
    val provider: String? = null,
    val modelId: String? = null,
    val taskId: String? = null,
    val agentId: String? = null,
    val agentType: String? = null,
    val label: String? = null,
    val summary: String? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val cacheReadTokens: Long? = null,
    val cacheCreationTokens: Long? = null,
    val costUsd: Double? = null,
    val contextRatio: Double? = null,
    val contextState: String? = null,
    val durationMs: Long? = null,
)

/** Types that carry only transport metadata and must never reach the canvas. */
private val HIDDEN_EVENT_TYPES = setOf(
    "activity", "tokens", "codex_token_usage", "step_boundary", "turn_diagnostics",
    "command_lifecycle", "interrupt_receipt", "queue_recovery", "delegation_state",
    "tool_use_summary", "user_message_resolution", "codex_safety_buffering",
    "codex_moderation_metadata", "turn_health", "conversation_reset",
)

/**
 * Folds the ordered event stream into renderable timeline items.
 *
 * Adjacent tool calls within a turn merge into one [ChatTimelineItem.ToolGroup];
 * adjacent file changes merge into one [ChatTimelineItem.FilesChanged]; assistant
 * text with the same stable message id is replaced in place so streaming deltas
 * do not append duplicate rows.
 */
internal fun foldChatTranscript(
    events: List<ChatEvent>,
    sessionProvider: String? = null,
    sessionModelId: String? = null,
): ChatTranscript {
    val items = mutableListOf<ChatTimelineItem>()
    val approvals = LinkedHashMap<String, ChatApproval>()
    val assistantIndexById = HashMap<String, Int>()
    val subagentIndexById = HashMap<String, Int>()
    val toolIndexByItemId = HashMap<String, Pair<Int, Int>>()

    var contextRatio: Double? = null
    var contextState: String? = null
    var turnLive = false
    var latestModelId: String? = sessionModelId
    var currentTurnId: String? = null
    var turnHadTools = false
    var openToolGroupIndex: Int? = null
    var openFilesIndex: Int? = null

    fun closeGroups() {
        openToolGroupIndex = null
        openFilesIndex = null
    }

    fun startTurn(event: ChatEvent) {
        currentTurnId = event.turnId
        turnHadTools = false
        turnLive = true
        closeGroups()
        items.add(
            ChatTimelineItem.TurnStart(
                id = "turn-start-${event.turnId ?: items.size}",
                timestampIso = event.timestampIso,
                provider = event.provider ?: sessionProvider,
            ),
        )
    }

    for (event in events) {
        val type = event.type.trim().lowercase().replace('-', '_')
        if (type in HIDDEN_EVENT_TYPES) continue

        if (event.turnId != null && event.turnId != currentTurnId &&
            type !in setOf("done", "status")
        ) {
            startTurn(event)
        }

        when (type) {
            "status" -> {
                when (event.status?.trim()?.lowercase()) {
                    "started" -> if (event.turnId != currentTurnId) startTurn(event)
                    "completed", "failed", "interrupted" -> turnLive = false
                }
            }

            "user_message" -> {
                val text = event.text?.takeIf(String::isNotBlank) ?: continue
                closeGroups()
                items.add(
                    ChatTimelineItem.UserMessage(
                        id = "user-${event.itemId ?: event.messageId ?: items.size}",
                        text = text,
                        provider = event.provider ?: sessionProvider,
                        modelId = event.modelId ?: latestModelId,
                    ),
                )
            }

            "text", "assistant_text" -> {
                val text = event.text ?: continue
                val stableId = event.messageId?.takeIf(String::isNotBlank)
                    ?: event.itemId?.takeIf(String::isNotBlank)
                    ?: "assistant-${items.size}"
                val existing = assistantIndexById[stableId]
                if (existing != null) {
                    val previous = (items[existing] as? ChatTimelineItem.AssistantMessage)?.text.orEmpty()
                    items[existing] = ChatTimelineItem.AssistantMessage(
                        "assistant-$stableId",
                        mergeAssistantText(previous, text),
                        turnLive,
                    )
                } else {
                    closeGroups()
                    assistantIndexById[stableId] = items.size
                    items.add(ChatTimelineItem.AssistantMessage("assistant-$stableId", text, turnLive))
                }
            }

            "tool_call", "command" -> {
                val itemId = event.itemId ?: "tool-${items.size}"
                val call = ChatToolCall(
                    itemId = itemId,
                    tool = event.tool ?: "tool",
                    slug = toolSlug(event.tool ?: "tool"),
                    target = toolTarget(event.argsText),
                    detail = event.argsText,
                    status = if (type == "command") parseToolStatus(event.status) else ToolCallStatus.RUNNING,
                )
                turnHadTools = true
                openFilesIndex = null
                val groupIndex = openToolGroupIndex
                if (groupIndex != null) {
                    val group = items[groupIndex] as ChatTimelineItem.ToolGroup
                    toolIndexByItemId[itemId] = groupIndex to group.calls.size
                    items[groupIndex] = group.copy(calls = group.calls + call)
                } else {
                    toolIndexByItemId[itemId] = items.size to 0
                    openToolGroupIndex = items.size
                    items.add(ChatTimelineItem.ToolGroup("tools-${event.turnId ?: items.size}-$itemId", listOf(call)))
                }
            }

            "tool_result" -> {
                val itemId = event.itemId ?: continue
                val located = toolIndexByItemId[itemId] ?: continue
                val group = items[located.first] as? ChatTimelineItem.ToolGroup ?: continue
                val calls = group.calls.toMutableList()
                if (located.second !in calls.indices) continue
                calls[located.second] = calls[located.second].copy(
                    status = parseToolStatus(event.status ?: "completed"),
                    detail = event.resultText ?: calls[located.second].detail,
                )
                items[located.first] = group.copy(calls = calls)
            }

            "file_change" -> {
                val path = event.path ?: continue
                val diff = event.diff.orEmpty()
                val counts = diffCounts(diff)
                val change = ChatFileChange(
                    itemId = event.itemId ?: "file-${items.size}",
                    path = path,
                    kind = parseFileChangeKind(event.kind),
                    diff = diff,
                    additions = counts.first,
                    deletions = counts.second,
                )
                turnHadTools = true
                openToolGroupIndex = null
                val groupIndex = openFilesIndex
                if (groupIndex != null) {
                    val group = items[groupIndex] as ChatTimelineItem.FilesChanged
                    val replaced = group.files.indexOfFirst { it.itemId == change.itemId }
                    val files = group.files.toMutableList()
                    if (replaced >= 0) files[replaced] = change else files.add(change)
                    items[groupIndex] = group.copy(files = files)
                } else {
                    openFilesIndex = items.size
                    items.add(
                        ChatTimelineItem.FilesChanged(
                            "files-${event.turnId ?: items.size}-${change.itemId}",
                            listOf(change),
                        ),
                    )
                }
            }

            "subagent_started", "subagent.started", "subagent_progress", "subagent.progress",
            "subagent_result", "subagent.completed",
            -> {
                val taskId = event.taskId ?: event.agentId ?: continue
                val agentId = event.agentId ?: taskId
                val status = if (type.contains("result") || type.contains("completed")) {
                    parseSubagentStatus(event.status)
                } else {
                    SubagentStatus.RUNNING
                }
                val snapshot = ChatSubagent(
                    taskId = taskId,
                    agentId = agentId,
                    name = event.label?.takeIf(String::isNotBlank)
                        ?: event.agentType?.takeIf(String::isNotBlank)
                        ?: event.description?.takeIf(String::isNotBlank)?.take(48)
                        ?: "Subagent",
                    agentType = event.agentType,
                    status = status,
                    summary = event.summary?.takeIf(String::isNotBlank)
                        ?: event.description?.takeIf(String::isNotBlank),
                    durationLabel = event.durationMs?.let(::formatShortDuration),
                )
                closeGroups()
                val existing = subagentIndexById[taskId]
                if (existing != null) {
                    val previous = (items[existing] as ChatTimelineItem.Subagent).snapshot
                    items[existing] = ChatTimelineItem.Subagent(
                        "subagent-$taskId",
                        snapshot.copy(
                            summary = snapshot.summary ?: previous.summary,
                            durationLabel = snapshot.durationLabel ?: previous.durationLabel,
                        ),
                    )
                } else {
                    subagentIndexById[taskId] = items.size
                    items.add(ChatTimelineItem.Subagent("subagent-$taskId", snapshot))
                }
            }

            "approval_request" -> {
                val itemId = event.itemId ?: continue
                approvals[itemId] = ChatApproval(
                    itemId = itemId,
                    kind = event.kind.orEmpty(),
                    description = event.description ?: event.text.orEmpty(),
                    provider = event.provider ?: sessionProvider,
                    plan = event.kind?.trim()?.lowercase()?.contains("plan") == true,
                )
            }

            "pending_input_resolved" -> event.itemId?.let(approvals::remove)

            "plan" -> {
                val explanation = event.text ?: event.description
                if (!explanation.isNullOrBlank()) {
                    closeGroups()
                    items.add(ChatTimelineItem.AssistantMessage("plan-${items.size}", explanation, false))
                }
            }

            "error" -> {
                closeGroups()
                items.add(
                    ChatTimelineItem.Notice(
                        "error-${items.size}",
                        event.text ?: event.description ?: "The agent reported an error.",
                        failure = true,
                    ),
                )
            }

            "context_usage" -> {
                contextRatio = event.contextRatio
                contextState = event.contextState
            }

            "done" -> {
                turnLive = false
                latestModelId = event.modelId ?: latestModelId
                closeGroups()
                val summary = ChatUsageSummary(
                    inputTokens = event.inputTokens ?: 0,
                    outputTokens = event.outputTokens ?: 0,
                    cacheReadTokens = event.cacheReadTokens ?: 0,
                    cacheCreationTokens = event.cacheCreationTokens ?: 0,
                    costUsd = event.costUsd ?: 0.0,
                )
                if (!summary.isEmpty) {
                    items.add(ChatTimelineItem.Usage("usage-${event.turnId ?: items.size}", summary))
                }
                items.add(
                    ChatTimelineItem.TurnEnd(
                        id = "turn-end-${event.turnId ?: items.size}",
                        timestampIso = event.timestampIso,
                        durationMs = event.durationMs,
                        hadTools = turnHadTools,
                    ),
                )
                currentTurnId = null
            }
        }
    }

    return ChatTranscript(
        items = items,
        pendingApprovals = approvals.values.toList(),
        contextRatio = contextRatio,
        contextState = contextState,
        turnLive = turnLive,
        latestModelId = latestModelId,
    )
}

/** Drops the MCP namespace so "mcp__github__list_prs" reads as "list_prs". */
internal fun toolSlug(tool: String): String =
    tool.substringAfterLast("__").ifEmpty { tool }

/** First meaningful line of the args, middle-truncated by the view. */
internal fun toolTarget(argsText: String?): String? =
    argsText?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.takeIf(String::isNotEmpty)

internal fun formatShortDuration(millis: Long): String {
    val seconds = (millis / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> "${seconds}s"
        seconds < 3_600 -> "${seconds / 60}m ${seconds % 60}s"
        else -> "${seconds / 3600}h ${(seconds % 3600) / 60}m"
    }
}

/** Middle-truncates a path so both the directory head and the filename survive. */
internal fun middleTruncate(value: String, max: Int = 44): String {
    if (value.length <= max || max < 6) return value
    val head = (max - 1) / 2
    val tail = max - 1 - head
    return value.take(head) + "…" + value.takeLast(tail)
}

// ---------------------------------------------------------------------------
// Composer placeholders
// ---------------------------------------------------------------------------

internal fun composerPlaceholder(pendingApprovals: List<ChatApproval>): String = when {
    pendingApprovals.isEmpty() -> "Type to vibecode..."
    pendingApprovals.size == 1 && pendingApprovals.first().plan -> "Review the plan above..."
    else -> "Answer the prompt above..."
}

// ---------------------------------------------------------------------------
// Model picker data — WorkModelPickerSheet.swift / WorkModelCatalog.swift
// ---------------------------------------------------------------------------

/**
 * A catalog entry. **Effort levels are host-supplied** — never hardcode the
 * list. Empty [reasoningEfforts] means the model has no effort control.
 * **Fast mode is a service tier**: supported iff [serviceTiers] contains "fast".
 */
internal data class ChatModelOption(
    val id: String,
    val name: String,
    val provider: String,
    val defaultReasoningEffort: String? = null,
    val reasoningEfforts: List<String> = emptyList(),
    val serviceTiers: List<String> = emptyList(),
) {
    /** Lowercased and de-duped, preserving host order. */
    val efforts: List<String>
        get() = reasoningEfforts.map { it.trim().lowercase() }.filter(String::isNotEmpty).distinct()

    val supportsFastMode: Boolean
        get() = serviceTiers.any { it.trim().equals("fast", ignoreCase = true) }
}

internal data class ChatModelSelection(
    val modelId: String?,
    val effort: String?,
    val fastMode: Boolean = false,
)

/** Switching model resets effort to that model's default and fast mode to false. */
internal fun selectModel(option: ChatModelOption): ChatModelSelection = ChatModelSelection(
    modelId = option.id,
    effort = option.defaultReasoningEffort?.trim()?.lowercase()?.takeIf { it in option.efforts }
        ?: option.efforts.firstOrNull(),
    fastMode = false,
)

internal enum class ModelRailKind { FAVOURITES, RECENTS, PROVIDER }

internal data class ModelRailItem(
    val kind: ModelRailKind,
    val key: String,
    val label: String,
    val badge: Int? = null,
)

internal fun modelRailItems(
    options: List<ChatModelOption>,
    favouriteIds: Set<String>,
    recentIds: List<String>,
): List<ModelRailItem> = buildList {
    add(ModelRailItem(ModelRailKind.FAVOURITES, "favourites", "Favourites", favouriteIds.size.takeIf { it > 0 }))
    add(ModelRailItem(ModelRailKind.RECENTS, "recents", "Recents", recentIds.size.takeIf { it > 0 }))
    options.map { it.provider.trim().lowercase() }.filter(String::isNotEmpty).distinct().forEach { provider ->
        add(
            ModelRailItem(
                ModelRailKind.PROVIDER,
                provider,
                provider.replaceFirstChar(Char::uppercase),
                options.count { it.provider.trim().lowercase() == provider },
            ),
        )
    }
}

internal fun modelsForRail(
    item: ModelRailItem,
    options: List<ChatModelOption>,
    favouriteIds: Set<String>,
    recentIds: List<String>,
    query: String,
): List<ChatModelOption> {
    val scoped = when (item.kind) {
        ModelRailKind.FAVOURITES -> options.filter { it.id in favouriteIds }
        ModelRailKind.RECENTS -> recentIds.mapNotNull { id -> options.firstOrNull { it.id == id } }
        ModelRailKind.PROVIDER -> options.filter { it.provider.trim().lowercase() == item.key }
    }
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return scoped
    return scoped.filter { needle in it.name.lowercase() || needle in it.id.lowercase() }
}

/** Bottom-bar fast-mode capsule text. */
internal fun fastModeLabel(option: ChatModelOption?, fastMode: Boolean): String = when {
    option?.supportsFastMode != true -> "No fast"
    fastMode -> "Fast on"
    else -> "Fast off"
}
