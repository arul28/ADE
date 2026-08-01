package com.ade.sync.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json

class InvalidationTest {
    @Test
    fun `maps host tables to Android refetch domains`() {
        assertEquals(setOf(InvalidationDomain.LANES), invalidationDomainsForTable("lanes"))
        assertTrue(InvalidationDomain.SESSIONS in invalidationDomainsForTable("terminal_sessions"))
        assertTrue(InvalidationDomain.CHATS in invalidationDomainsForTable("agent_chat_turns"))
        assertTrue(InvalidationDomain.PROJECTS in invalidationDomainsForTable("projects"))
        assertTrue(InvalidationDomain.ATTENTION in invalidationDomainsForTable("attention_items"))
        assertTrue(InvalidationDomain.USAGE in invalidationDomainsForTable("usage_events"))
    }

    @Test
    fun `malformed compact batches fail closed to a full refresh`() {
        listOf(
            "{}",
            "{\"fullRefresh\":false,\"fromDbVersion\":1,\"toDbVersion\":2,\"tables\":[]}",
            "{\"fullRefresh\":false,\"fromDbVersion\":\"1\",\"toDbVersion\":2,\"tables\":[\"lanes\"]}",
            "{\"fullRefresh\":false,\"fromDbVersion\":2,\"toDbVersion\":2,\"tables\":[\"lanes\"]}",
            "{\"fullRefresh\":false,\"fromDbVersion\":1,\"toDbVersion\":2,\"tables\":[\" lanes\"]}",
        ).forEach { raw ->
            assertTrue(validatedInvalidationBatch(Json.parseToJsonElement(raw)).fullRefresh, raw)
        }
    }

    @Test
    fun `valid compact batches retain deduplicated tables`() {
        val batch = validatedInvalidationBatch(Json.parseToJsonElement(
            "{\"fullRefresh\":false,\"fromDbVersion\":4,\"toDbVersion\":7,\"tables\":[\"lanes\",\"lanes\",\"sessions\"]}",
        ))
        assertEquals(false, batch.fullRefresh)
        assertEquals(4, batch.fromDbVersion)
        assertEquals(7, batch.toDbVersion)
        assertEquals(listOf("lanes", "sessions"), batch.tables)
    }
}
