package com.ade.android.ui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Converts the raw `chat_subscribe` / history-page envelopes into the pure
 * [ChatEvent] the transcript fold consumes.
 *
 * Wire contract mirrored from apps/ios/ADE/Models/RemoteModels.swift:2490-2830
 * (`AgentChatEvent.init(from:)`). Every field is best-effort: an unknown shape
 * degrades to a null field, never an exception, so a contract addition can
 * never drop a row.
 *
 * Deliberately Compose-free and Android-free so it unit-tests on the JVM.
 */
internal object ChatEventAdapter {

    fun adapt(events: List<JsonObject>): List<ChatEvent> = events.mapNotNull(::adapt)

    fun adapt(event: JsonObject): ChatEvent? {
        val type = event.str("type") ?: event.str("kind") ?: return null
        val usage = event["usage"] as? JsonObject
        val contextUsage = event["usage"] as? JsonObject
        return ChatEvent(
            type = type,
            timestampIso = event.str("timestamp") ?: event.str("createdAt"),
            turnId = event.str("turnId"),
            itemId = event.str("logicalItemId") ?: event.str("itemId"),
            messageId = event.str("messageId"),
            text = event.str("displayText") ?: event.str("text") ?: event.str("output")
                ?: event.str("message"),
            tool = event.str("tool") ?: event.str("toolName") ?: event.str("command"),
            argsText = flatten(event["args"]) ?: event.str("command"),
            resultText = flatten(event["result"]) ?: event.str("output"),
            status = event.str("status") ?: event.str("turnStatus"),
            path = event.str("path"),
            diff = event.str("diff") ?: event.str("patch"),
            kind = event.str("kind").takeIf { type.contains("file", true) || type.contains("approval", true) },
            description = event.str("description"),
            provider = event.str("provider"),
            modelId = event.str("modelId") ?: event.str("model"),
            taskId = event.str("taskId"),
            agentId = event.str("agentId"),
            agentType = event.str("agentType"),
            label = event.str("label"),
            summary = event.str("summary"),
            inputTokens = usage.num("inputTokens") ?: event.num("inputTokens"),
            outputTokens = usage.num("outputTokens") ?: event.num("outputTokens"),
            cacheReadTokens = usage.num("cacheReadTokens") ?: event.num("cacheReadTokens"),
            cacheCreationTokens = usage.num("cacheCreationTokens")
                ?: usage.num("cacheWriteTokens")
                ?: event.num("cacheCreationTokens"),
            costUsd = event["costUsd"]?.dbl(),
            contextRatio = contextRatio(contextUsage),
            contextState = event.str("state"),
            durationMs = event.num("durationMs"),
        )
    }

    /**
     * The ring needs a 0…1 ratio. `percentage` is authoritative when present;
     * otherwise it is derived from totalTokens/maxTokens. When neither exists
     * this returns null and the ring renders the honest "?" state — the value
     * is never invented.
     */
    private fun contextRatio(usage: JsonObject?): Double? {
        if (usage == null) return null
        usage["percentage"]?.dbl()?.let { return it / 100.0 }
        val total = usage.num("totalTokens") ?: return null
        val max = usage.num("maxTokens")?.takeIf { it > 0 } ?: return null
        return total.toDouble() / max.toDouble()
    }

    /** Renders a nested args/result value as the text the disclosure shows. */
    private fun flatten(element: JsonElement?): String? = when (element) {
        null -> null
        is JsonPrimitive -> element.contentOrNull?.takeIf(String::isNotBlank)
        is JsonArray -> element.mapNotNull(::flatten).joinToString("\n").takeIf(String::isNotBlank)
        is JsonObject -> {
            element.str("command")
                ?: element.str("path")
                ?: element.str("file_path")
                ?: element.str("text")
                ?: element.str("output")
                ?: element.str("content")
                ?: element.entries
                    .mapNotNull { (key, value) ->
                        (value as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)?.let { "$key: $it" }
                    }
                    .joinToString("\n")
                    .takeIf(String::isNotBlank)
        }
        else -> null
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)

    private fun JsonObject?.num(key: String): Long? =
        this?.get(key)?.jsonPrimitive?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

    private fun JsonElement.dbl(): Double? = (this as? JsonPrimitive)?.doubleOrNull
}
