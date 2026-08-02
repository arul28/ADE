package com.ade.android.pairing

import android.content.Context
import android.os.Build
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.ade.android.account.AuthRepository
import com.ade.android.security.MachineProfile
import com.ade.android.security.SavedEndpoint
import com.ade.android.security.SecureMachineStore
import com.ade.sync.client.AdeSyncClient
import com.ade.sync.client.AccountAdoptionCredentials
import com.ade.sync.client.PairedCredentials
import com.ade.sync.model.DirectoryMachine
import com.ade.sync.model.ReachableEndpoint
import com.ade.sync.model.PairingQrPayload
import com.ade.sync.model.SyncPeerMetadata
import com.ade.sync.pairing.PinPairingClient
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.ConnectionRaceException
import com.ade.sync.transport.RouteKind
import java.util.UUID
import java.security.MessageDigest
import java.net.URI
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient

class PairingRepository(
    private val context: Context,
    private val store: SecureMachineStore,
    private val auth: AuthRepository,
    http: OkHttpClient,
    private val sync: AdeSyncClient,
) {
    private val pairing = PinPairingClient(http)
    private val connectionMutex = Mutex()

    fun candidates(payload: PairingQrPayload): List<RouteCandidate> {
        val direct = payload.addressCandidates.mapNotNull { candidate ->
            if (candidate.kind == "loopback") return@mapNotNull null
            val kind = if (candidate.kind == "tailscale") RouteKind.TAILNET else RouteKind.LAN
            RouteCandidate("ws://${formatHost(candidate.host)}:${payload.port}", kind)
        }
        val relay = payload.relayUrl?.let { listOf(RouteCandidate(it, RouteKind.RELAY)) }.orEmpty()
        return (direct + relay).distinctBy(RouteCandidate::url)
    }

    suspend fun pair(payload: PairingQrPayload, pin: String): MachineProfile {
        val machineKey = payload.hostIdentity.deviceId
        val candidates = candidates(payload)
        require(candidates.isNotEmpty()) { "The QR code contains no reachable machine address" }
        val dpop = store.dpopKey(context, machineKey)
        val peer = peer(store.localDeviceId(), store.localSiteId())
        // Pairing mutates host trust, so perform it once on the best route. The
        // authenticated reconnect immediately below uses the full route race.
        val candidate = candidates.minBy(RouteCandidate::kind)
        val result = pairing.pair(candidate, pin, peer, dpop, auth::freshToken)
        val profile = MachineProfile(
            machineKey = machineKey,
            hostDeviceId = payload.hostIdentity.deviceId,
            name = payload.hostIdentity.name,
            pairedDeviceId = result.deviceId,
            siteId = peer.siteId,
            secret = result.secret,
            endpoints = candidates.map { SavedEndpoint(it.url, it.kind.name.lowercase()) },
        )
        // Persist before hello. A process death can now reconnect using the
        // staged secret; an older secret remains valid until pairing_commit.
        store.put(profile)
        store.setCurrent(machineKey)
        sync.seedCached(null, null)
        connect(profile)
        if (result.rotation?.pendingCommit == true) {
            sync.send("pairing_commit", buildJsonObject { put("deviceId", result.deviceId) }, UUID.randomUUID().toString())
        }
        val authenticatedHost = sync.hello.value?.brain
        val connected = store.get(machineKey) ?: profile
        val verified = connected.copy(
            hostDeviceId = authenticatedHost?.deviceId?.takeIf(String::isNotBlank) ?: connected.hostDeviceId,
            name = authenticatedHost?.deviceName?.takeIf(String::isNotBlank) ?: connected.name,
        )
        store.put(verified)
        return verified
    }

    suspend fun connect(profile: MachineProfile): Unit = connectionMutex.withLock {
        if (canReuseActiveConnection(
                statusState = sync.status.value.state,
                currentMachineKey = store.current()?.machineKey,
                targetMachineKey = profile.machineKey,
            )) return@withLock
        val dpop = store.dpopKey(context, profile.machineKey)
        val fingerprint = networkFingerprint()
        if (profile.connectionAuthKind == "bootstrap") {
            sync.connectBootstrap(
                candidates = profile.routeCandidates(fingerprint),
                peer = peer(profile.pairedDeviceId, profile.siteId),
                token = profile.bootstrapToken ?: error("The saved project connection is incomplete"),
                expectedHostDeviceId = profile.hostDeviceId,
            )
        } else {
            sync.connectPaired(
                candidates = profile.routeCandidates(fingerprint),
                peer = peer(profile.pairedDeviceId, profile.siteId),
                credentials = PairedCredentials(
                    deviceId = profile.pairedDeviceId,
                    secret = profile.secret,
                    dpopKey = dpop,
                    freshRelayAccountToken = auth::freshToken,
                ),
                expectedHostDeviceId = profile.hostDeviceId.takeUnless { it.startsWith(NEARBY_ID_PREFIX) },
            )
        }
        val endpoint = sync.status.value.endpoint
        val memory = if (fingerprint != null && endpoint != null) {
            profile.routeMemory.toMutableMap().apply {
                remove(fingerprint)
                put(fingerprint, endpoint)
            }.entries.toList().takeLast(8).associate { it.toPair() }
        } else profile.routeMemory
        val authenticatedHost = sync.hello.value?.brain
        val verifiedHostId = authenticatedHost?.deviceId?.takeIf(String::isNotBlank)
        if (!profile.hostDeviceId.startsWith(NEARBY_ID_PREFIX) && verifiedHostId != null) {
            require(verifiedHostId == profile.hostDeviceId) { "Connected machine identity did not match the stored pairing" }
        }
        store.put(profile.copy(
            hostDeviceId = verifiedHostId ?: profile.hostDeviceId,
            name = authenticatedHost?.deviceName?.takeIf(String::isNotBlank) ?: profile.name,
            endpoints = mergeLearnedRelayEndpoint(profile.endpoints, sync.hello.value?.cloudRelayWssUrl),
            routeMemory = memory,
            lastConnectedAt = System.currentTimeMillis(),
        ))
        store.setCurrent(profile.machineKey)
    }

    /** Applies the endpoint lease returned by project_switch_result and reconnects immediately. */
    suspend fun reconnectProject(connection: JsonObject): MachineProfile {
        val current = store.current() ?: error("Reconnect to a machine before opening a project")
        val identity = connection["hostIdentity"]?.jsonObject
            ?: error("The project connection omitted the host identity")
        val hostDeviceId = identity.string("deviceId")
            ?: error("The project connection omitted the host device ID")
        require(hostDeviceId == current.hostDeviceId) {
            "The project moved to a different machine. Pair with that machine before opening it."
        }
        val port = connection["port"]?.jsonPrimitive?.content?.toIntOrNull()
            ?: error("The project connection omitted its port")
        val currentStatus = sync.status.value
        if (canRetainProjectHandoffSocket(
                statusState = currentStatus.state,
                statusEndpoint = currentStatus.endpoint,
                currentHostDeviceId = current.hostDeviceId,
                targetHostDeviceId = hostDeviceId,
                targetPort = port,
            )) {
            val retained = current.copy(name = identity.string("name") ?: current.name)
            store.put(retained)
            return retained
        }
        val advertisedEndpoints = connection["addressCandidates"]?.jsonArray.orEmpty().mapNotNull { element ->
            val candidate = element.jsonObject
            val host = candidate.string("host") ?: return@mapNotNull null
            val kind = candidate.string("kind") ?: "lan"
            if (kind == "loopback") return@mapNotNull null
            val routeKind = when (kind) {
                "tailscale" -> "tailnet"
                "relay" -> "relay"
                "saved", "lan" -> "lan"
                else -> return@mapNotNull null
            }
            val url = if (host.startsWith("ws://") || host.startsWith("wss://")) {
                host
            } else {
                "ws://${formatHost(host)}:$port"
            }
            SavedEndpoint(url, routeKind)
        }
        // A project handoff commonly keeps the same shared listener. Preserve
        // the route that just proved reachable when the host reports that same
        // port; advertised LAN addresses can be unusable behind an emulator,
        // VPN, container, or port forward even though the active route works.
        val status = sync.status.value
        val activeEndpoint = preferredProjectHandoffEndpoint(
            statusEndpoint = status.endpoint,
            statusRoute = status.route?.name?.lowercase(),
            savedEndpoints = current.endpoints,
            port = port,
        )
        val endpoints = mergeProjectHandoffEndpoints(activeEndpoint, advertisedEndpoints)
        require(endpoints.isNotEmpty()) { "The project connection contains no reachable machine address" }
        val authKind = connection.string("authKind") ?: "paired"
        require(authKind == "paired" || authKind == "bootstrap") { "Unsupported project authentication mode" }
        val updated = current.copy(
            name = identity.string("name") ?: current.name,
            pairedDeviceId = connection.string("pairedDeviceId") ?: current.pairedDeviceId,
            endpoints = endpoints,
            connectionAuthKind = authKind,
            bootstrapToken = if (authKind == "bootstrap") {
                connection.string("token") ?: error("The project connection omitted its bootstrap token")
            } else null,
        )
        store.put(updated)
        connectProjectHandoff(updated)
        return store.get(updated.machineKey) ?: updated
    }

    private suspend fun connectProjectHandoff(profile: MachineProfile) {
        var failureIndex = 0
        while (true) {
            try {
                connect(profile)
                return
            } catch (error: Throwable) {
                val retryDelay = projectHandoffRetryDelay(failureIndex, error) ?: throw error
                failureIndex += 1
                delay(retryDelay)
            }
        }
    }

    suspend fun adopt(machine: DirectoryMachine): MachineProfile {
        val expectedHostDeviceId = machine.deviceId?.takeIf(String::isNotBlank)
            ?: error("This directory entry does not include a machine identity")
        val candidates = accountMachineRouteCandidates(machine.reachableEndpoints)
        require(candidates.isNotEmpty()) { "This machine has no reachable endpoints" }
        val dpop = store.dpopKey(context, machine.machineKey)
        val localDeviceId = store.localDeviceId()
        val localSiteId = store.localSiteId()
        val adopted = sync.connectAccount(
            candidates = candidates,
            peer = peer(localDeviceId, localSiteId),
            credentials = AccountAdoptionCredentials(localDeviceId, dpop, auth::freshToken),
            expectedHostDeviceId = expectedHostDeviceId,
            directorySigningPublicKey = machine.pubkey,
        )
        val profile = MachineProfile(
            machineKey = machine.machineKey,
            hostDeviceId = expectedHostDeviceId,
            accountMachineKey = machine.machineKey,
            name = machine.customName ?: machine.name ?: machine.platform ?: "ADE machine",
            pairedDeviceId = adopted.pairing.deviceId,
            siteId = localSiteId,
            secret = adopted.pairing.secret,
            endpoints = mergeLearnedRelayEndpoint(
                candidates.map { SavedEndpoint(it.url, it.kind.name.lowercase()) },
                adopted.hello.cloudRelayWssUrl,
            ),
            directorySigningPublicKey = machine.pubkey,
            lastConnectedAt = System.currentTimeMillis(),
        )
        // The sealed hello minted a durable paired secret. Persist it before
        // exposing the connected state so a process death never loses trust.
        store.put(profile)
        store.setCurrent(profile.machineKey)
        return profile
    }

    fun disconnect() = sync.disconnect()

    fun forget(machineKey: String) {
        sync.disconnect()
        store.forget(machineKey)
    }

    private fun peer(deviceId: String, siteId: String) = SyncPeerMetadata(
        deviceId = deviceId,
        deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
        siteId = siteId,
        appVersion = com.ade.android.BuildConfig.VERSION_NAME,
        appBuild = com.ade.android.BuildConfig.VERSION_CODE.toString(),
        bundleIdentifier = com.ade.android.BuildConfig.APPLICATION_ID,
    )

    private fun formatHost(host: String): String {
        val trimmed = host.trim().removePrefix("[").removeSuffix("]")
        return if (':' in trimmed) "[$trimmed]" else trimmed
    }

    private fun networkFingerprint(): String? {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork ?: return null
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return null
        val transport = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        }
        val links = connectivity.getLinkProperties(network)
        val routeIdentity = links?.routes.orEmpty().mapNotNull { route ->
            route.gateway?.hostAddress ?: route.destination.address.hostAddress
        }.sorted().joinToString(",")
        val raw = "$transport|${links?.interfaceName.orEmpty()}|$routeIdentity"
        return MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
            .take(12).joinToString("") { "%02x".format(it) }
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.content
        ?.takeIf(String::isNotBlank)

    companion object {
        private const val NEARBY_ID_PREFIX = "nearby-"
    }
}

internal fun mergeProjectHandoffEndpoints(
    activeEndpoint: SavedEndpoint?,
    advertisedEndpoints: List<SavedEndpoint>,
): List<SavedEndpoint> = (listOfNotNull(activeEndpoint) + advertisedEndpoints)
    .distinctBy(SavedEndpoint::url)

internal fun canReuseActiveConnection(
    statusState: String,
    currentMachineKey: String?,
    targetMachineKey: String,
): Boolean = statusState == "connected" && currentMachineKey == targetMachineKey

/**
 * Keeps a route that already reached this machine across the brain's project-host
 * swap. The old socket can close before the switch response is processed, so the
 * last status is useful even after it stops saying `connected`; the persisted
 * candidates are the final fallback for that same-machine, same-port handoff.
 */
internal fun preferredProjectHandoffEndpoint(
    statusEndpoint: String?,
    statusRoute: String?,
    savedEndpoints: List<SavedEndpoint>,
    port: Int,
): SavedEndpoint? {
    val live = statusEndpoint?.let { url ->
        val route = statusRoute ?: return@let null
        if (runCatching { URI(url).port }.getOrNull() == port) SavedEndpoint(url, route) else null
    }
    if (live != null) return live
    return savedEndpoints.firstOrNull { endpoint ->
        runCatching { URI(endpoint.url).port }.getOrNull() == port
    }
}

internal fun accountMachineRouteCandidates(endpoints: List<ReachableEndpoint>): List<RouteCandidate> =
    endpoints.flatMap { endpoint ->
        val kind = when (endpoint.kind) {
            "lan" -> RouteKind.LAN
            "tailnet" -> RouteKind.TAILNET
            "relay" -> RouteKind.RELAY
            else -> return@flatMap emptyList()
        }
        buildList {
            endpoint.url?.trim()?.takeIf(String::isNotEmpty)?.let { add(RouteCandidate(it, kind)) }
            val host = endpoint.host?.trim()?.takeIf(String::isNotEmpty)
            val port = endpoint.port
            if (kind != RouteKind.RELAY && host != null && port != null && port in 1..65535) {
                val normalizedHost = host.removePrefix("[").removeSuffix("]")
                val formattedHost = if (':' in normalizedHost) "[$normalizedHost]" else normalizedHost
                add(RouteCandidate("ws://$formattedHost:$port", kind))
            }
        }
    }.distinctBy(RouteCandidate::url)

internal fun projectHandoffRetryDelay(failureIndex: Int, error: Throwable): Long? {
    if (error !is ConnectionRaceException) return null
    return listOf(400L, 900L).getOrNull(failureIndex)
}

internal fun canRetainProjectHandoffSocket(
    statusState: String,
    statusEndpoint: String?,
    currentHostDeviceId: String,
    targetHostDeviceId: String,
    targetPort: Int,
): Boolean = statusState == "connected" &&
    currentHostDeviceId == targetHostDeviceId &&
    statusEndpoint != null &&
    runCatching { URI(statusEndpoint).port }.getOrNull() == targetPort

internal fun mergeLearnedRelayEndpoint(
    endpoints: List<SavedEndpoint>,
    cloudRelayWssUrl: String?,
): List<SavedEndpoint> {
    val relay = cloudRelayWssUrl?.trim()?.takeIf { it.startsWith("wss://") }
        ?.let { SavedEndpoint(it, "relay") }
    return (endpoints + listOfNotNull(relay)).distinctBy(SavedEndpoint::url)
}
