package com.ade.sync.protocol

import com.ade.sync.model.InvalidationBatch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

enum class InvalidationDomain { LANES, SESSIONS, CHATS, PROJECTS, ATTENTION, USAGE }

val ALL_ANDROID_INVALIDATION_DOMAINS = InvalidationDomain.entries.toSet()

fun validatedInvalidationBatch(payload: JsonElement): InvalidationBatch {
    val full = InvalidationBatch(fullRefresh = true)
    val source = payload as? JsonObject ?: return full
    val fullRefresh = (source["fullRefresh"] as? JsonPrimitive)
        ?.takeUnless(JsonPrimitive::isString)?.booleanOrNull ?: return full
    if (fullRefresh) return full
    val from = (source["fromDbVersion"] as? JsonPrimitive)
        ?.takeUnless(JsonPrimitive::isString)?.longOrNull ?: return full
    val to = (source["toDbVersion"] as? JsonPrimitive)
        ?.takeUnless(JsonPrimitive::isString)?.longOrNull ?: return full
    val rawTables = source["tables"] as? JsonArray ?: return full
    if (from < 0 || to <= from || rawTables.isEmpty() || rawTables.size > 128) return full
    val tables = rawTables.map { value ->
        val primitive = value as? JsonPrimitive ?: return full
        if (!primitive.isString) return full
        val table = primitive.content
        if (
            table.isEmpty() || table.trim() != table || '\u0000' in table ||
            table.toByteArray().size > 256
        ) return full
        table
    }
    if (tables.sumOf { it.toByteArray().size + 3 } > 16 * 1024) return full
    return InvalidationBatch(from, to, tables.distinct(), fullRefresh = false)
}

fun invalidationDomainsForTable(table: String): Set<InvalidationDomain> {
    val normalized = table.lowercase()
    val domains = mutableSetOf<InvalidationDomain>()
    if ("lane" in normalized || "worktree" in normalized) domains += InvalidationDomain.LANES
    if (
        "terminal" in normalized || "pty" in normalized || "runtime" in normalized ||
        "session" in normalized
    ) domains += InvalidationDomain.SESSIONS
    if ("chat" in normalized || "agent" in normalized || "turn" in normalized) domains += InvalidationDomain.CHATS
    if ("project" in normalized || "repository" in normalized) domains += InvalidationDomain.PROJECTS
    if ("attention" in normalized || "notification" in normalized) domains += InvalidationDomain.ATTENTION
    if ("usage" in normalized || "quota" in normalized) domains += InvalidationDomain.USAGE
    return domains
}

class InvalidationScheduler(
    private val scope: CoroutineScope,
    private val debounceMillis: Long = 250,
    private val onInvalidated: suspend (Set<InvalidationDomain>) -> Unit,
) {
    private val pending = mutableSetOf<InvalidationDomain>()
    private var flushJob: Job? = null

    @Synchronized
    fun receive(batch: InvalidationBatch) {
        if (batch.fullRefresh || batch.tables.size > 128 || encodedTableBytes(batch.tables) > 16 * 1024) {
            pending += ALL_ANDROID_INVALIDATION_DOMAINS
        } else {
            pending += batch.tables.flatMap(::invalidationDomainsForTable)
        }
        // Bound latency from the first invalidation. A busy stream cannot keep
        // resetting the timer and starve a UI refetch indefinitely.
        if (flushJob == null) flushJob = scope.launch {
            delay(debounceMillis)
            flush()
        }
    }

    fun fullRefresh() {
        synchronized(this) {
            pending += ALL_ANDROID_INVALIDATION_DOMAINS
            if (flushJob == null) flushJob = scope.launch { flush() }
        }
    }

    @Synchronized
    fun cancel() {
        flushJob?.cancel()
        flushJob = null
        pending.clear()
    }

    private suspend fun flush() {
        val domains = synchronized(this) {
            val snapshot = pending.toSet()
            pending.clear()
            flushJob = null
            snapshot
        }
        if (domains.isNotEmpty()) onInvalidated(domains)
    }

    private fun encodedTableBytes(tables: List<String>): Int = tables.sumOf { it.toByteArray().size + 3 }
}
