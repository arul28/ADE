package com.ade.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TerminalTranscriptTest {
    private fun payload(json: String): JsonObject = Json.parseToJsonElement(json) as JsonObject

    private fun snapshot(state: TerminalTranscriptState, json: String) =
        mergeTerminalPayload(state, payload(json), replace = true)

    private fun data(state: TerminalTranscriptState, json: String) =
        mergeTerminalPayload(state, payload(json), replace = false)

    @Test
    fun `first snapshot replaces the buffer and records the covered range`() {
        val state = snapshot(
            TerminalTranscriptState("stale"),
            """{"sessionId":"s","transcript":"hello","startOffset":100,"endOffset":105}""",
        )

        assertEquals("hello", state.data)
        assertEquals(100L, state.startOffset)
        assertEquals(105L, state.endOffset)
        assertEquals(false, state.atStart, "a tail snapshot has earlier scrollback to load")
    }

    @Test
    fun `snapshot starting at zero marks the transcript as complete`() {
        val state = snapshot(TerminalTranscriptState(), """{"transcript":"hi","startOffset":0,"endOffset":2}""")
        assertTrue(state.atStart)
    }

    @Test
    fun `live data chunks append and advance the resume marker`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"a","startOffset":0,"endOffset":1}""")
        state = data(state, """{"data":"b","offset":2}""")
        state = data(state, """{"data":"c","offset":3}""")

        assertEquals("abc", state.data)
        assertEquals(0L, state.startOffset)
        assertEquals(3L, state.endOffset)
        assertTrue(state.atStart)
    }

    @Test
    fun `delta snapshot on reconnect appends instead of replacing and does not duplicate`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"abc","startOffset":0,"endOffset":3}""")
        // Reconnect: subscribe(sinceOffset = 3) -> host serves only the new bytes.
        state = snapshot(state, """{"transcript":"de","delta":true,"startOffset":3,"endOffset":5}""")

        assertEquals("abcde", state.data)
        assertEquals(0L, state.startOffset, "a delta must not move the scrollback floor")
        assertEquals(5L, state.endOffset)
        assertTrue(state.atStart)
    }

    @Test
    fun `non-delta snapshot on reconnect replaces so the tail is never doubled`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"abc","startOffset":0,"endOffset":3}""")
        // Host could not serve sinceOffset..end inside maxBytes: full tail instead.
        state = snapshot(state, """{"transcript":"cde","startOffset":2,"endOffset":5}""")

        assertEquals("cde", state.data)
        assertEquals(2L, state.startOffset)
        assertEquals(5L, state.endOffset)
        assertEquals(false, state.atStart)
    }

    @Test
    fun `a chunk without an offset invalidates the resume marker`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"abc","startOffset":0,"endOffset":3}""")
        state = data(state, """{"data":"xyz"}""")

        assertEquals("abcxyz", state.data)
        assertNull(
            state.endOffset,
            "keeping offset 3 would make the next resume request a delta from 3 and re-append xyz",
        )
    }

    @Test
    fun `a later offset-carrying chunk restores the resume marker`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"abc","startOffset":0,"endOffset":3}""")
        state = data(state, """{"data":"xyz"}""")
        state = data(state, """{"data":"!","offset":7}""")

        assertEquals(7L, state.endOffset)
    }

    @Test
    fun `history pages prepend and stop once the start is reached`() {
        var state = snapshot(TerminalTranscriptState(), """{"transcript":"tail","startOffset":200,"endOffset":204}""")

        state = prependTerminalHistory(state, payload("""{"data":"mid","startOffset":100,"atStart":false}"""), 200)
        assertEquals("midtail", state.data)
        assertEquals(100L, state.startOffset)
        assertEquals(false, state.atStart)

        state = prependTerminalHistory(state, payload("""{"data":"head","startOffset":0,"atStart":true}"""), 100)
        assertEquals("headmidtail", state.data)
        assertEquals(0L, state.startOffset)
        assertTrue(state.atStart)
        assertEquals(204L, state.endOffset, "loading older history must not disturb the live resume marker")
    }

    @Test
    fun `history page without a start offset falls back to the requested boundary`() {
        val state = prependTerminalHistory(
            TerminalTranscriptState("tail", startOffset = 50),
            payload("""{"data":"x"}"""),
            50,
        )
        assertEquals(50L, state.startOffset)
        assertEquals(false, state.atStart)
    }

    @Test
    fun `live data after a bounded-history snapshot keeps the buffer contiguous`() {
        // 2 MiB maxBytes: the host caps the snapshot at a tail window.
        val tail = "x".repeat(64)
        var state = snapshot(
            TerminalTranscriptState(),
            """{"transcript":"$tail","startOffset":9000,"endOffset":9064}""",
        )
        state = data(state, """{"data":"y","offset":9065}""")

        assertEquals(tail + "y", state.data)
        assertEquals(9000L, state.startOffset)
        assertEquals(false, state.atStart, "the truncated head must stay reachable through terminal_history")
    }
}
