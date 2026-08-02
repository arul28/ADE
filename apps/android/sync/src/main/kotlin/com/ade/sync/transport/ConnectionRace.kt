package com.ade.sync.transport

import java.util.LinkedHashMap
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeout

enum class RouteKind(val rank: Int) { LAN(0), TAILNET(1), RELAY(2) }

data class RouteCandidate(
    val url: String,
    val kind: RouteKind,
    val remembered: Boolean = false,
)

data class ConnectedRoute<T>(val candidate: RouteCandidate, val connection: T)

class ConnectionRaceException(val failures: List<Pair<RouteCandidate, Throwable>>) :
    IllegalStateException(connectionRaceFailureMessage(failures))

internal fun connectionRaceFailureMessage(failures: List<Pair<RouteCandidate, Throwable>>): String {
    val actionable = failures.asSequence().map { it.second }.firstOrNull { error ->
        error !is TimeoutCancellationException &&
            !error.message.orEmpty().contains("connection route already won", ignoreCase = true)
    }
    return actionable?.message
        ?: failures.lastOrNull()?.second?.message
        ?: "No ADE route connected"
}

class ConnectionRace(
    private val candidateStaggerMillis: Long = 250,
    private val overallBudgetMillis: Long = 10_000,
    private val relayJoinDelayMillis: Long = 300,
    private val maximumCandidates: Int = 3,
    private val maximumConcurrentSockets: Int = 3,
) {
    suspend fun <T> connect(
        candidates: List<RouteCandidate>,
        dial: suspend (RouteCandidate) -> T,
    ): ConnectedRoute<T> = coroutineScope {
        val selected = plan(candidates)
        require(selected.isNotEmpty()) { "No dialable ADE routes are available" }
        val outcomes = Channel<Pair<RouteCandidate, Result<T>>>(selected.size)
        val semaphore = Semaphore(maximumConcurrentSockets)
        val failures = mutableListOf<Pair<RouteCandidate, Throwable>>()
        val tasks = selected.mapIndexed { index, candidate ->
            async {
                val stagger = index * candidateStaggerMillis
                val relayDelay = if (candidate.kind == RouteKind.RELAY && selected.any { it.kind != RouteKind.RELAY }) {
                    relayJoinDelayMillis
                } else 0
                delay(stagger + relayDelay)
                val outcome = runCatching { semaphore.withPermit { dial(candidate) } }
                outcomes.send(candidate to outcome)
            }
        }
        try {
            withTimeout(overallBudgetMillis) {
                repeat(selected.size) {
                    val (candidate, outcome) = outcomes.receive()
                    outcome.fold(
                        onSuccess = { return@withTimeout ConnectedRoute(candidate, it) },
                        onFailure = { error ->
                            if (error !is CancellationException) {
                                failures += candidate to error
                            }
                        },
                    )
                }
                throw ConnectionRaceException(failures)
            }
        } catch (error: Throwable) {
            if (error is ConnectionRaceException) throw error
            if (error is CancellationException && error !is TimeoutCancellationException) throw error
            throw ConnectionRaceException(failures + (selected.last() to error))
        } finally {
            tasks.forEach { it.cancel() }
            outcomes.close()
        }
    }

    fun plan(candidates: List<RouteCandidate>): List<RouteCandidate> {
        val ranked = candidates.distinctBy(RouteCandidate::url).sortedWith(
            compareByDescending<RouteCandidate> { it.remembered }
                .thenBy { it.kind.rank }
                // A Tailscale DNS alias only resolves when MagicDNS is present on
                // the dialing device. Keep aliases as fallbacks, but prefer the
                // simultaneously advertised numeric address so emulators and
                // other tailnet-routed clients do not spend their one Tailnet
                // race slot on an unresolvable hostname.
                .thenBy(::directHostRank),
        )
        if (ranked.isEmpty()) return emptyList()
        val selected = mutableListOf(ranked.first())
        ranked.drop(1).firstOrNull { it.kind != selected.first().kind }?.let(selected::add)
        for (candidate in ranked) {
            if (selected.size >= maximumCandidates) break
            if (selected.none { it.kind == candidate.kind }) selected += candidate
        }
        for (candidate in ranked) {
            if (selected.size >= maximumCandidates) break
            if (candidate !in selected) selected += candidate
        }
        return selected
    }

    private fun directHostRank(candidate: RouteCandidate): Int {
        if (candidate.kind == RouteKind.RELAY) return 0
        val host = runCatching { URI(candidate.url).host }.getOrNull().orEmpty()
        return if (host.count { it == '.' } == 3 && host.split('.').all { part ->
                part.toIntOrNull()?.let { it in 0..255 } == true
            } || ':' in host
        ) 0 else 1
    }
}

class NetworkRouteMemory(private val capacity: Int = 8) {
    private val routes = LinkedHashMap<String, String>()

    @Synchronized
    fun remember(networkFingerprint: String?, endpoint: String) {
        if (networkFingerprint.isNullOrBlank() || endpoint.isBlank()) return
        routes.remove(networkFingerprint)
        routes[networkFingerprint] = endpoint.trim()
        while (routes.size > capacity) routes.remove(routes.keys.first())
    }

    @Synchronized
    fun endpointFor(networkFingerprint: String?): String? = networkFingerprint?.let(routes::get)
}
