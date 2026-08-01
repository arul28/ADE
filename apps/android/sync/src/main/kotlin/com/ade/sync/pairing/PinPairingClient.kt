package com.ade.sync.pairing

import com.ade.sync.auth.DpopKey
import com.ade.sync.model.PairingRequest
import com.ade.sync.model.PairingResult
import com.ade.sync.model.PairingRotation
import com.ade.sync.model.SyncPeerMetadata
import com.ade.sync.protocol.EnvelopeCodec
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.RouteKind
import com.ade.sync.transport.RouteSecurity
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class PairingRejected(val code: String, message: String) : IllegalStateException(message)

data class SuccessfulPairing(
    val deviceId: String,
    val secret: String,
    val rotation: PairingRotation?,
)

class PinPairingClient(
    private val http: OkHttpClient,
    private val codec: EnvelopeCodec = EnvelopeCodec(),
) {
    suspend fun pair(
        candidate: RouteCandidate,
        pin: String,
        peer: SyncPeerMetadata,
        dpopKey: DpopKey,
        freshRelayAccountToken: (suspend () -> String?)? = null,
        timeoutMillis: Long = 10_000,
    ): SuccessfulPairing {
        require(pin.matches(Regex("^[0-9]{6}$"))) { "Enter the six-digit pairing PIN" }
        val safeCandidate = RouteSecurity.requireSafe(candidate)
        val relayToken = if (safeCandidate.kind == RouteKind.RELAY) freshRelayAccountToken?.invoke() else null
        val request = PairingRequest(
            code = pin,
            peer = peer,
            relayAccountToken = relayToken,
            dpopPublicKey = Base64.getEncoder().encodeToString(dpopKey.publicKeyX963),
        )
        return withTimeout(timeoutMillis) { openAndPair(safeCandidate, request) }
    }

    private suspend fun openAndPair(candidate: RouteCandidate, payload: PairingRequest): SuccessfulPairing =
        suspendCancellableCoroutine { continuation ->
            val relay = candidate.kind == RouteKind.RELAY
            val url = if (relay) candidate.url.toHttpUrl().newBuilder()
                .setQueryParameter("ready", "2").build().toString() else candidate.url
            var sent = false
            var accepted = false
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!relay) sendPairing(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (relay && !sent) {
                        val control = runCatching { codec.json.parseToJsonElement(text).jsonObject }.getOrNull()
                        val type = control?.get("t")?.jsonPrimitive?.content
                        val version = control?.get("v")?.jsonPrimitive?.content
                        if (type == "accepted" && version == "2") accepted = true
                        if (type == "ready" && version == "2" && accepted) sendPairing(webSocket)
                        return
                    }
                    val envelope = runCatching { codec.decode(text) }.getOrElse {
                        fail(webSocket, it)
                        return
                    }
                    if (envelope.type != "pairing_result") return // additive extensions are ignored
                    val result = runCatching {
                        codec.json.decodeFromJsonElement(PairingResult.serializer(), envelope.payload)
                    }.getOrElse {
                        fail(webSocket, it)
                        return
                    }
                    if (!result.ok || result.deviceId.isNullOrBlank() || result.secret.isNullOrBlank()) {
                        fail(webSocket, PairingRejected(
                            result.error?.code ?: "pairing_failed",
                            result.error?.message ?: "The machine rejected pairing",
                        ))
                        return
                    }
                    if (continuation.isActive) continuation.resume(SuccessfulPairing(
                        deviceId = requireNotNull(result.deviceId),
                        secret = requireNotNull(result.secret),
                        rotation = result.rotation,
                    ))
                    webSocket.close(1000, "Pairing credential received")
                }

                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = onMessage(webSocket, bytes.utf8())

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = fail(webSocket, t)

                private fun sendPairing(socket: WebSocket) {
                    if (sent) return
                    sent = true
                    val element = codec.json.encodeToJsonElement(PairingRequest.serializer(), payload)
                    socket.send(codec.encode("pairing_request", element, "pairing"))
                }

                private fun fail(socket: WebSocket, error: Throwable) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                    socket.close(4000, "Pairing failed")
                }
            }
            val webSocket = http.newWebSocket(Request.Builder().url(url).build(), listener)
            continuation.invokeOnCancellation { webSocket.close(1000, "Pairing cancelled") }
        }
}
