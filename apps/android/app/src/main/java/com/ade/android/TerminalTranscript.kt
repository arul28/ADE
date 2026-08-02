package com.ade.android

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * Client-side view of a terminal transcript: the text the emulator has been
 * fed plus the byte offsets that let a resubscribe resume instead of
 * re-downloading (and re-appending) the tail.
 */
data class TerminalTranscriptState(
    val data: String = "",
    val startOffset: Long? = null,
    val endOffset: Long? = null,
    val atStart: Boolean = false,
)

private fun JsonObject.longOrNull(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString || it.content.isNotBlank() }?.content?.toLongOrNull()

private fun JsonObject.textOrEmpty(key: String): String =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()

private fun JsonObject.flag(key: String): Boolean = this[key]?.jsonPrimitive?.content == "true"

/**
 * Applies a `terminal_snapshot` (replace = true) or `terminal_data`
 * (replace = false) payload.
 *
 * `endOffset`/`offset` is the resume marker sent back as `sinceOffset` on the
 * next `terminal_subscribe`. The host documents it as optional — untracked
 * sessions, disabled transcript writes and the byte cap all omit it. Keeping a
 * previous offset while appending bytes that offset does not cover would make
 * the next resume ask for a delta the client has already applied, duplicating
 * scrollback. So an absent offset invalidates the marker and the next
 * resubscribe asks for a full snapshot instead.
 */
fun mergeTerminalPayload(
    state: TerminalTranscriptState,
    source: JsonObject,
    replace: Boolean,
): TerminalTranscriptState {
    val text = source.textOrEmpty(if (replace) "transcript" else "data")
    val deltaSnapshot = replace && source.flag("delta")
    val start = source.longOrNull("startOffset")
    val end = source.longOrNull("endOffset") ?: source.longOrNull("offset")
    val rewrite = replace && !deltaSnapshot
    return TerminalTranscriptState(
        data = if (rewrite) text else state.data + text,
        startOffset = if (rewrite) start else state.startOffset,
        endOffset = end,
        atStart = if (rewrite) (start ?: 0) <= 0 else state.atStart,
    )
}

/** Applies a `terminal_history` page fetched by pulling up at the top of the view. */
fun prependTerminalHistory(state: TerminalTranscriptState, page: JsonObject, requestedBefore: Long): TerminalTranscriptState {
    val start = page.longOrNull("startOffset") ?: requestedBefore
    return state.copy(
        data = page.textOrEmpty("data") + state.data,
        startOffset = start,
        atStart = page.flag("atStart") || start <= 0,
    )
}
