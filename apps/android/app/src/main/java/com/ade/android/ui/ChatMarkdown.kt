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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Assistant markdown rendering, ported from
 * apps/ios/ADE/Views/Work/WorkMarkdownViews.swift and WorkMarkdownParsing.swift.
 *
 * Assistant answers are PLAIN FLOWING MARKDOWN on the flat canvas — no bubble,
 * no card, no border. Just left-aligned prose that reads like a document.
 */

private val MONO = FontFamily.Monospace

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

private val INLINE_PATTERN = Regex(
    """`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|__(.+?)__|~~(.+?)~~|\[([^\]]+)]\(([^)\s]+)\)|(https?://[^\s<>()]+)""",
    RegexOption.DOT_MATCHES_ALL,
)

/**
 * Bold / italic / strikethrough / links / bare autolinks, plus the inline code
 * chip: accent@14% background, accent foreground, caption monospaced semibold.
 */
@Composable
internal fun markdownInline(text: String): AnnotatedString {
    val colors = AdeTokens.colors
    return remember(text, colors) {
        buildAnnotatedString {
            var cursor = 0
            for (match in INLINE_PATTERN.findAll(text)) {
                if (match.range.first > cursor) append(text.substring(cursor, match.range.first))
                val g = match.groupValues
                when {
                    g[1].isNotEmpty() -> withSpan(
                        SpanStyle(
                            color = colors.accent,
                            background = colors.accent.copy(alpha = 0.14f),
                            fontFamily = MONO,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp,
                        ),
                        g[1],
                    )
                    g[2].isNotEmpty() -> withSpan(
                        SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic),
                        g[2],
                    )
                    g[3].isNotEmpty() -> withSpan(SpanStyle(fontWeight = FontWeight.Bold), g[3])
                    g[4].isNotEmpty() -> withSpan(SpanStyle(fontStyle = FontStyle.Italic), g[4])
                    g[5].isNotEmpty() -> withSpan(SpanStyle(fontWeight = FontWeight.Bold), g[5])
                    g[6].isNotEmpty() -> withSpan(
                        SpanStyle(textDecoration = TextDecoration.LineThrough),
                        g[6],
                    )
                    g[7].isNotEmpty() -> {
                        pushStringAnnotation("url", g[8])
                        withSpan(
                            SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
                            g[7],
                        )
                        pop()
                    }
                    g[9].isNotEmpty() -> {
                        pushStringAnnotation("url", g[9])
                        withSpan(
                            SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
                            g[9],
                        )
                        pop()
                    }
                }
                cursor = match.range.last + 1
            }
            if (cursor < text.length) append(text.substring(cursor))
        }
    }
}

private fun androidx.compose.ui.text.AnnotatedString.Builder.withSpan(style: SpanStyle, value: String) {
    pushStyle(style)
    append(value)
    pop()
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Renders a parsed message. When [monospaced] the whole message is one
 * monospaced caption block with lineSpacing 3 — the fixed-column fallback.
 */
@Composable
internal fun MarkdownBody(
    text: String,
    monospaced: Boolean,
    blocks: List<MarkdownBlock>,
    modifier: Modifier = Modifier,
) {
    val colors = AdeTokens.colors
    if (monospaced) {
        Box(modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            Text(
                text,
                fontFamily = MONO,
                fontSize = 12.sp,
                lineHeight = 15.sp,
                color = colors.textPrimary,
                softWrap = false,
            )
        }
        return
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        blocks.forEach { block -> MarkdownBlockView(block.kind) }
    }
}

@Composable
private fun MarkdownBlockView(kind: MarkdownBlockKind) {
    val colors = AdeTokens.colors
    when (kind) {
        is MarkdownBlockKind.Paragraph -> Text(
            markdownInline(kind.text),
            fontSize = 15.sp,
            lineHeight = 22.sp,
            color = colors.textPrimary,
        )

        is MarkdownBlockKind.Heading -> Text(
            markdownInline(kind.text),
            fontSize = when (kind.level) {
                1 -> 20.sp
                2 -> 17.sp
                else -> 15.sp
            },
            lineHeight = when (kind.level) {
                1 -> 26.sp
                2 -> 23.sp
                else -> 21.sp
            },
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
        )

        is MarkdownBlockKind.UnorderedList -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            kind.items.forEach { item ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("•", fontSize = 15.sp, lineHeight = 22.sp, color = colors.accent)
                    Text(markdownInline(item), fontSize = 15.sp, lineHeight = 22.sp, color = colors.textPrimary)
                }
            }
        }

        is MarkdownBlockKind.OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            kind.items.forEachIndexed { index, item ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "${kind.start + index}.",
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                        color = colors.accent,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(markdownInline(item), fontSize = 15.sp, lineHeight = 22.sp, color = colors.textPrimary)
                }
            }
        }

        is MarkdownBlockKind.Blockquote -> Row(
            Modifier
                .fillMaxWidth()
                .background(colors.surface.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
                .padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier
                    .width(3.dp)
                    .height((kind.lines.size * 22).coerceAtLeast(22).dp)
                    .background(colors.accent.copy(alpha = 0.55f), RoundedCornerShape(2.dp)),
            )
            Text(
                markdownInline(kind.lines.joinToString("\n")),
                fontSize = 15.sp,
                lineHeight = 22.sp,
                color = colors.textSecondary,
            )
        }

        is MarkdownBlockKind.Table -> MarkdownTable(kind)

        is MarkdownBlockKind.Code -> MarkdownCode(kind)

        MarkdownBlockKind.Rule -> Box(
            Modifier.fillMaxWidth().height(1.dp).background(colors.glassBorder),
        )
    }
}

@Composable
private fun MarkdownTable(table: MarkdownBlockKind.Table) {
    val colors = AdeTokens.colors
    Box(
        Modifier
            .fillMaxWidth()
            .border(0.5.dp, colors.glassBorder, RoundedCornerShape(12.dp))
            .horizontalScroll(rememberScrollState()),
    ) {
        Column {
            Row(Modifier.background(colors.surface.copy(alpha = 0.70f))) {
                table.headers.forEach { header ->
                    Text(
                        header,
                        Modifier.widthIn(min = 120.dp).padding(10.dp),
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                    )
                }
            }
            table.rows.forEach { row ->
                Row {
                    row.forEach { cell ->
                        Text(
                            markdownInline(cell),
                            Modifier.widthIn(min = 120.dp).padding(10.dp),
                            fontSize = 13.sp,
                            color = colors.textSecondary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownCode(code: MarkdownBlockKind.Code) {
    val colors = AdeTokens.colors
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.surface.copy(alpha = 0.65f), RoundedCornerShape(14.dp))
            .padding(4.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                code.language?.uppercase().orEmpty(),
                fontSize = 10.sp,
                fontFamily = MONO,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.6.sp,
                color = colors.textMuted,
            )
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { clipboard.setText(AnnotatedString(code.code)) }) {
                Text("Copy", fontSize = 11.sp, color = colors.accent)
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .background(colors.recessed.copy(alpha = 0.90f), RoundedCornerShape(12.dp))
                .horizontalScroll(rememberScrollState())
                .padding(10.dp),
        ) {
            Text(
                highlightCode(code.code, code.language, colors.textPrimary, colors.accent, colors.success, colors.textMuted),
                fontFamily = MONO,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                softWrap = false,
            )
        }
    }
}

private val CODE_KEYWORDS = setOf(
    "fun", "val", "var", "class", "object", "interface", "return", "if", "else", "when", "for",
    "while", "import", "package", "private", "internal", "public", "override", "suspend", "data",
    "const", "function", "let", "def", "async", "await", "export", "default", "new", "type",
    "struct", "enum", "extension", "guard", "case", "switch", "func", "static", "final", "true",
    "false", "null", "nil", "None", "True", "False", "this", "self",
)

private val CODE_TOKEN = Regex("""("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|//[^\n]*|#[^\n]*|\b\w+\b)""")

/** Lightweight, language-agnostic tokenizer — enough to lift keywords and strings. */
private fun highlightCode(
    code: String,
    language: String?,
    base: Color,
    keyword: Color,
    string: Color,
    comment: Color,
): AnnotatedString = buildAnnotatedString {
    pushStyle(SpanStyle(color = base))
    var cursor = 0
    for (match in CODE_TOKEN.findAll(code)) {
        if (match.range.first > cursor) append(code.substring(cursor, match.range.first))
        val token = match.value
        val style = when {
            token.startsWith("\"") || token.startsWith("'") -> SpanStyle(color = string)
            token.startsWith("//") || (token.startsWith("#") && language != "sh") -> SpanStyle(color = comment)
            token in CODE_KEYWORDS -> SpanStyle(color = keyword, fontWeight = FontWeight.SemiBold)
            else -> null
        }
        if (style == null) append(token) else {
            pushStyle(style)
            append(token)
            pop()
        }
        cursor = match.range.last + 1
    }
    if (cursor < code.length) append(code.substring(cursor))
    pop()
}
