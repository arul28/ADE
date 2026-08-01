package com.ade.android.pairing

import com.ade.android.findRosterProjectForSession
import com.ade.android.security.SavedEndpoint
import com.ade.sync.model.RosterChat
import com.ade.sync.model.RosterProject
import com.ade.sync.model.RosterSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals

class PairingRepositoryTest {
    @Test
    fun `learned cloud relay is persisted once and only when secure`() {
        val lan = SavedEndpoint("ws://192.168.1.4:8788", "lan")

        assertEquals(
            listOf(lan, SavedEndpoint("wss://relay.example/connect/machine", "relay")),
            mergeLearnedRelayEndpoint(listOf(lan), " wss://relay.example/connect/machine "),
        )
        assertEquals(
            listOf(lan),
            mergeLearnedRelayEndpoint(listOf(lan), "ws://relay.example/connect/machine"),
        )
    }

    @Test
    fun `project handoff keeps the currently reachable route first`() {
        val active = SavedEndpoint("ws://10.0.2.2:8788", "lan")
        val advertised = listOf(
            SavedEndpoint("ws://192.168.1.10:8788", "lan"),
            SavedEndpoint("wss://relay.example.test/host", "relay"),
        )

        assertEquals(listOf(active) + advertised, mergeProjectHandoffEndpoints(active, advertised))
    }

    @Test
    fun `project handoff removes a duplicate active route`() {
        val active = SavedEndpoint("ws://host.test:8788", "lan")

        assertEquals(
            listOf(active),
            mergeProjectHandoffEndpoints(active, listOf(active)),
        )
    }

    @Test
    fun `self managed association is skipped when the platform withholds its protected permission`() {
        assertEquals(false, canRequestSelfManagedAssociation(34, true, false))
        assertEquals(true, canRequestSelfManagedAssociation(34, true, true))
    }

    @Test
    fun `session deep link resolves its owning roster project`() {
        val project = RosterProject(
            projectId = "project-1",
            displayName = "Project one",
            chats = listOf(RosterChat(id = "session-1", laneId = "lane-1", status = "idle")),
        )

        assertEquals(project, findRosterProjectForSession(RosterSnapshot(7, listOf(project)), "session-1"))
    }
}
