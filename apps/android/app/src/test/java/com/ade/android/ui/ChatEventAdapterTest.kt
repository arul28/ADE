package com.ade.android.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

class ChatEventAdapterTest {

    @Test
    fun `an assistant text event carries its stable message id`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("messageId", "m1")
                put("turnId", "t1")
            },
        )
        assertEquals("text", event?.type)
        assertEquals("hello", event?.text)
        assertEquals("m1", event?.messageId)
    }

    @Test
    fun `displayText wins over text on user messages`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "user_message")
                put("text", "raw")
                put("displayText", "pretty")
            },
        )
        assertEquals("pretty", event?.text)
    }

    @Test
    fun `logical item id wins so retried tool calls collapse`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "tool_call")
                put("tool", "Read")
                put("itemId", "physical")
                put("logicalItemId", "logical")
            },
        )
        assertEquals("logical", event?.itemId)
    }

    @Test
    fun `nested tool args flatten into displayable text`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "tool_call")
                put("tool", "Bash")
                put("itemId", "a")
                putJsonObject("args") { put("command", "./gradlew test") }
            },
        )
        assertEquals("./gradlew test", event?.argsText)
    }

    @Test
    fun `array results join into lines`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "tool_result")
                put("tool", "Grep")
                put("itemId", "a")
                put(
                    "result",
                    buildJsonArray {
                        add(kotlinx.serialization.json.JsonPrimitive("one"))
                        add(kotlinx.serialization.json.JsonPrimitive("two"))
                    },
                )
            },
        )
        assertEquals("one\ntwo", event?.resultText)
    }

    @Test
    fun `usage fields are lifted out of the nested done payload`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "done")
                put("turnId", "t1")
                put("status", "completed")
                put("costUsd", 0.42)
                putJsonObject("usage") {
                    put("inputTokens", 120)
                    put("outputTokens", 34)
                    put("cacheReadTokens", 900)
                    put("cacheCreationTokens", 12)
                }
            },
        )
        assertEquals(120L, event?.inputTokens)
        assertEquals(34L, event?.outputTokens)
        assertEquals(900L, event?.cacheReadTokens)
        assertEquals(12L, event?.cacheCreationTokens)
        assertEquals(0.42, event?.costUsd)
    }

    @Test
    fun `context usage percentage becomes a zero to one ratio`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "context_usage")
                putJsonObject("usage") {
                    put("totalTokens", 50_000)
                    put("maxTokens", 200_000)
                    put("percentage", 25.0)
                }
            },
        )
        assertEquals(0.25, event?.contextRatio)
    }

    @Test
    fun `context usage falls back to totals when percentage is absent`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "context_usage")
                putJsonObject("usage") {
                    put("totalTokens", 50_000)
                    put("maxTokens", 200_000)
                }
            },
        )
        assertEquals(0.25, event?.contextRatio)
    }

    @Test
    fun `a context usage event with neither yields no ratio, never a guess`() {
        val event = ChatEventAdapter.adapt(
            buildJsonObject {
                put("type", "context_usage")
                putJsonObject("usage") { put("model", "claude-opus-5") }
            },
        )
        assertNull(event?.contextRatio)
    }

    @Test
    fun `an event without a type is dropped rather than throwing`() {
        assertNull(ChatEventAdapter.adapt(buildJsonObject { put("text", "orphan") }))
    }

    @Test
    fun `adapting a stream folds end to end`() {
        val transcript = foldChatTranscript(
            ChatEventAdapter.adapt(
                listOf(
                    buildJsonObject {
                        put("type", "user_message")
                        put("turnId", "t1")
                        put("text", "fix the bug")
                    },
                    buildJsonObject {
                        put("type", "tool_call")
                        put("turnId", "t1")
                        put("tool", "Read")
                        put("itemId", "i1")
                        putJsonObject("args") { put("path", "Main.kt") }
                    },
                    buildJsonObject {
                        put("type", "tool_result")
                        put("turnId", "t1")
                        put("tool", "Read")
                        put("itemId", "i1")
                        put("status", "completed")
                        put("result", "ok")
                    },
                    buildJsonObject {
                        put("type", "text")
                        put("turnId", "t1")
                        put("messageId", "m1")
                        put("text", "Fixed it.")
                    },
                ),
            ),
            sessionProvider = "claude",
        )
        assertTrue(transcript.items.any { it is ChatTimelineItem.UserMessage })
        val group = transcript.items.filterIsInstance<ChatTimelineItem.ToolGroup>().single()
        assertEquals(ToolCallStatus.COMPLETED, group.calls.single().status)
        assertEquals("Main.kt", group.calls.single().target)
        assertEquals(
            "Fixed it.",
            transcript.items.filterIsInstance<ChatTimelineItem.AssistantMessage>().single().text,
        )
    }
}
