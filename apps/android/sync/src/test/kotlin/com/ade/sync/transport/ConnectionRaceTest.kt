package com.ade.sync.transport

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class ConnectionRaceTest {
    @Test
    fun `credential routes require secure relay or private direct hosts`() {
        assertEquals("wss://relay.example/connect/key", RouteSecurity.requireSafe(
            RouteCandidate("wss://relay.example/connect/key", RouteKind.RELAY),
        ).url)
        assertEquals("ws://192.168.1.8:8788", RouteSecurity.requireSafe(
            RouteCandidate("ws://192.168.1.8:8788", RouteKind.LAN),
        ).url)
        assertEquals("ws://host.tailnet.ts.net:8788", RouteSecurity.requireSafe(
            RouteCandidate("ws://host.tailnet.ts.net:8788", RouteKind.TAILNET),
        ).url)
        assertFailsWith<IllegalArgumentException> {
            RouteSecurity.requireSafe(RouteCandidate("ws://relay.example/connect/key", RouteKind.RELAY))
        }
        assertFailsWith<IllegalArgumentException> {
            RouteSecurity.requireSafe(RouteCandidate("wss://attacker.example/socket", RouteKind.LAN))
        }
    }

    @Test
    fun `plans at most three diverse ranked routes`() {
        val race = ConnectionRace()
        val plan = race.plan(listOf(
            RouteCandidate("wss://relay", RouteKind.RELAY),
            RouteCandidate("ws://tail", RouteKind.TAILNET),
            RouteCandidate("ws://lan", RouteKind.LAN),
            RouteCandidate("ws://lan-2", RouteKind.LAN),
        ))
        assertEquals(listOf(RouteKind.LAN, RouteKind.TAILNET, RouteKind.RELAY), plan.map(RouteCandidate::kind))
    }

    @Test
    fun `numeric tailnet route wins its race slot over MagicDNS alias`() {
        val race = ConnectionRace()
        val plan = race.plan(listOf(
            RouteCandidate("ws://192.168.1.44:8787", RouteKind.LAN),
            RouteCandidate("ws://studio.example.ts.net:8787", RouteKind.TAILNET),
            RouteCandidate("ws://100.75.20.63:8787", RouteKind.TAILNET),
            RouteCandidate("wss://relay.example/connect/studio", RouteKind.RELAY),
        ))

        assertEquals(
            listOf(
                "ws://192.168.1.44:8787",
                "ws://100.75.20.63:8787",
                "wss://relay.example/connect/studio",
            ),
            plan.map(RouteCandidate::url),
        )
    }

    @Test
    fun `remembered MagicDNS route still stays first`() {
        val race = ConnectionRace()
        val plan = race.plan(listOf(
            RouteCandidate("ws://studio.example.ts.net:8787", RouteKind.TAILNET, remembered = true),
            RouteCandidate("ws://100.75.20.63:8787", RouteKind.TAILNET),
        ))

        assertEquals("ws://studio.example.ts.net:8787", plan.first().url)
    }

    @Test
    fun `first authenticated route wins and slower routes are cancelled`() = runTest {
        val race = ConnectionRace(candidateStaggerMillis = 1, relayJoinDelayMillis = 1, overallBudgetMillis = 1_000)
        val winner = race.connect(listOf(
            RouteCandidate("ws://slow", RouteKind.LAN),
            RouteCandidate("ws://fast", RouteKind.TAILNET),
        )) { candidate ->
            delay(if (candidate.url.endsWith("fast")) 5 else 100)
            candidate.url
        }
        assertEquals("ws://fast", winner.connection)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `caller cancellation is not converted into a route failure`() = runTest {
        val race = ConnectionRace(candidateStaggerMillis = 0, overallBudgetMillis = 60_000)
        val deferred = async {
            race.connect(listOf(RouteCandidate("ws://slow", RouteKind.LAN))) {
                delay(60_000)
                "never"
            }
        }
        runCurrent()
        deferred.cancel(CancellationException("caller stopped"))

        assertIs<CancellationException>(runCatching { deferred.await() }.exceptionOrNull())
    }

    @Test
    fun `specific host incompatibility wins over route arbitration noise`() {
        val lan = RouteCandidate("ws://lan", RouteKind.LAN)
        val tailnet = RouteCandidate("ws://tail", RouteKind.TAILNET)

        assertEquals(
            "This ADE host does not support Android thin sync.",
            connectionRaceFailureMessage(listOf(
                tailnet to IllegalStateException("A newer connection route already won."),
                lan to IllegalStateException("This ADE host does not support Android thin sync."),
            )),
        )
    }
}
