package com.ade.android

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

class ChatEventNormalizationTest {
    @Test
    fun `live chat wrapper exposes its event while preserving stream metadata`() {
        val normalized = normalizeChatEventEnvelope(buildJsonObject {
            put("sessionId", "chat-1")
            put("seq", 42)
            putJsonObject("event") {
                put("type", "content_block_delta")
                putJsonObject("delta") {
                    put("type", "text_delta")
                    put("text", "Hello")
                }
            }
        })

        assertEquals("content_block_delta", normalized["type"]?.jsonPrimitive?.content)
        assertEquals("chat-1", normalized["sessionId"]?.jsonPrimitive?.content)
        assertEquals("42", normalized["seq"]?.jsonPrimitive?.content)
    }
}
