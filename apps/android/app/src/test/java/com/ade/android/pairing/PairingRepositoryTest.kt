package com.ade.android.pairing

import com.ade.android.findRosterProjectForSession
import com.ade.android.security.SavedEndpoint
import com.ade.sync.model.RosterChat
import com.ade.sync.model.RosterProject
import com.ade.sync.model.RosterSnapshot
import com.ade.sync.model.ReachableEndpoint
import com.ade.sync.transport.ConnectionRaceException
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.RouteKind
import kotlin.test.Test
import kotlin.test.assertEquals

class PairingRepositoryTest {
    @Test
    fun `account adoption keeps concrete host fallback beside canonical URL`() {
        assertEquals(
            listOf(
                RouteCandidate("ws://studio.example.tailnet:8787", RouteKind.TAILNET),
                RouteCandidate("ws://100.75.20.63:8787", RouteKind.TAILNET),
            ),
            accountMachineRouteCandidates(
                listOf(
                    ReachableEndpoint(
                        kind = "tailnet",
                        url = "ws://studio.example.tailnet:8787",
                        host = "100.75.20.63",
                        port = 8787,
                    ),
                ),
            ),
        )
    }

    @Test
    fun `duplicate reconnect work reuses the active machine socket`() {
        assertEquals(true, canReuseActiveConnection("connected", "machine-1", "machine-1"))
        assertEquals(false, canReuseActiveConnection("connecting", "machine-1", "machine-1"))
        assertEquals(false, canReuseActiveConnection("connected", "machine-1", "machine-2"))
    }

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
    fun `project handoff preserves saved emulator route after old socket closes`() {
        val emulator = SavedEndpoint("ws://10.0.2.2:8787", "lan")
        val stalePort = SavedEndpoint("ws://10.0.2.2:8788", "lan")

        assertEquals(
            emulator,
            preferredProjectHandoffEndpoint(
                statusEndpoint = null,
                statusRoute = null,
                savedEndpoints = listOf(stalePort, emulator),
                port = 8787,
            ),
        )
    }

    @Test
    fun `project handoff keeps last status route after disconnect race`() {
        val emulator = SavedEndpoint("ws://10.0.2.2:8787", "lan")

        assertEquals(
            emulator,
            preferredProjectHandoffEndpoint(
                statusEndpoint = emulator.url,
                statusRoute = emulator.kind,
                savedEndpoints = emptyList(),
                port = 8787,
            ),
        )
    }

    @Test
    fun `project handoff retries a bounded route race but not an identity failure`() {
        val route = RouteCandidate("ws://10.0.2.2:8787", RouteKind.LAN)
        val routeFailure = ConnectionRaceException(listOf(route to IllegalStateException("socket closed")))

        assertEquals(400L, projectHandoffRetryDelay(0, routeFailure))
        assertEquals(900L, projectHandoffRetryDelay(1, routeFailure))
        assertEquals(null, projectHandoffRetryDelay(2, routeFailure))
        assertEquals(null, projectHandoffRetryDelay(0, IllegalArgumentException("identity mismatch")))
    }

    @Test
    fun `same machine project handoff retains the adopted socket`() {
        assertEquals(
            true,
            canRetainProjectHandoffSocket(
                statusState = "connected",
                statusEndpoint = "ws://10.0.2.2:8787",
                currentHostDeviceId = "host-1",
                targetHostDeviceId = "host-1",
                targetPort = 8787,
            ),
        )
        assertEquals(
            false,
            canRetainProjectHandoffSocket(
                statusState = "connected",
                statusEndpoint = "ws://10.0.2.2:8787",
                currentHostDeviceId = "host-1",
                targetHostDeviceId = "host-2",
                targetPort = 8787,
            ),
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
