package com.ade.android.ui

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class ChatEventPresentationTest {
    @Test
    fun `transport metadata is hidden from the transcript`() {
        listOf("activity", "codex_token_usage", "status", "done").forEach { type ->
            assertFalse(isUserVisibleChatEvent(buildJsonObject {
                put("type", type)
                put("sessionId", "internal-id")
                put("timestamp", "2026-08-02T01:45:00Z")
            }))
        }
    }

    @Test
    fun `messages tools patches and approvals remain visible`() {
        assertTrue(isUserVisibleChatEvent(buildJsonObject { put("type", "text"); put("text", "hello") }))
        assertTrue(isUserVisibleChatEvent(buildJsonObject { put("type", "tool_call"); put("toolName", "Read") }))
        assertTrue(isUserVisibleChatEvent(buildJsonObject { put("type", "file_change"); put("patch", "+line") }))
        assertTrue(isUserVisibleChatEvent(buildJsonObject { put("type", "approval_request"); put("itemId", "1") }))
    }
}
