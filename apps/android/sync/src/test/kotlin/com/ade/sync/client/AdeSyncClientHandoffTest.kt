package com.ade.sync.client

import com.ade.sync.auth.JvmDpopKey
import com.ade.sync.model.EnabledFeature
import com.ade.sync.model.HelloFeatures
import com.ade.sync.model.HelloOkPayload
import com.ade.sync.model.RosterProject
import com.ade.sync.model.RosterSnapshot
import com.ade.sync.model.SyncPeerMetadata
import com.ade.sync.protocol.EnvelopeCodec
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.RouteKind
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class AdeSyncClientHandoffTest {
    @Test
    fun `frames buffer only for an armed socket and drain once in arrival order`() {
        val handoff = InboundHandoff()
        val socket = Any()

        assertTrue(!handoff.record(socket, "before-hello-ok"))

        handoff.arm(socket)
        assertTrue(handoff.record(socket, "first"))
        assertTrue(handoff.record(socket, "second"))

        assertEquals(listOf("first", "second"), handoff.drain(socket))
        // Draining hands the socket over to the live path, so later frames are
        // no longer buffered behind it.
        assertEquals(emptyList(), handoff.drain(socket))
        assertTrue(!handoff.record(socket, "after-activation"))
    }

    @Test
    fun `a losing or closed socket never leaks its buffered frames`() {
        val handoff = InboundHandoff()
        val loser = Any()
        val winner = Any()
        handoff.arm(loser)
        handoff.arm(winner)
        handoff.record(loser, "loser-frame")
        handoff.record(winner, "winner-frame")

        handoff.discard(loser)

        assertEquals(emptyList(), handoff.drain(loser))
        assertEquals(listOf("winner-frame"), handoff.drain(winner))

        handoff.arm(winner)
        handoff.record(winner, "stale")
        handoff.clear()
        assertEquals(emptyList(), handoff.drain(winner))
    }

    @Test
    fun `buffering stops at the cap instead of growing without bound`() {
        val handoff = InboundHandoff(capacity = 2)
        val socket = Any()
        handoff.arm(socket)

        assertTrue(handoff.record(socket, "a"))
        assertTrue(handoff.record(socket, "b"))
        assertTrue(!handoff.record(socket, "c"))

        assertEquals(listOf("a", "b"), handoff.drain(socket))
    }

    /**
     * A restarted host answers `hello_ok` and pushes its state in the same TCP
     * write. Those follow-up frames reach OkHttp's reader thread while the
     * connect coroutine is still unwinding the route race, so the socket is
     * authenticated but not yet published as the active one. They used to match
     * no branch of the pre-auth handler and vanish, which is how a reply to an
     * in-flight request could go missing and leave the app spinning until the
     * request timeout.
     */
    @Test
    fun `state pushed with hello_ok survives the pre-activation window`() {
        val codec = EnvelopeCodec()
        val hello = codec.encode(
            "hello_ok",
            codec.json.encodeToJsonElement(
                HelloOkPayload.serializer(),
                HelloOkPayload(
                    brain = SyncPeerMetadata(
                        deviceId = "host-1",
                        deviceName = "Test host",
                        siteId = "site-1",
                    ),
                    features = HelloFeatures(
                        invalidationOnlyV1 = EnabledFeature(enabled = true),
                        compactInvalidationV1 = EnabledFeature(enabled = true),
                    ),
                ),
            ),
        )
        val roster = codec.encode(
            "roster_snapshot",
            codec.json.encodeToJsonElement(
                RosterSnapshot.serializer(),
                RosterSnapshot(seq = 7, projects = listOf(RosterProject(
                    projectId = "project-1",
                    displayName = "Project one",
                ))),
            ),
        )

        BurstingSyncHost(listOf(hello, roster)).use { host ->
            val client = AdeSyncClient()
            try {
                runBlocking {
                    client.connectPaired(
                        candidates = listOf(RouteCandidate("ws://127.0.0.1:${host.port}", RouteKind.LAN)),
                        peer = SyncPeerMetadata(
                            deviceId = "android-1",
                            deviceName = "Pixel",
                            siteId = "site-android",
                        ),
                        credentials = PairedCredentials(
                            deviceId = "android-1",
                            secret = "paired-secret",
                            dpopKey = JvmDpopKey.generate(),
                        ),
                        expectedHostDeviceId = null,
                    )
                }

                assertEquals(7, client.roster.value?.seq)
            } finally {
                client.close()
            }
        }
    }
}

/**
 * A minimal RFC 6455 endpoint that completes the handshake and then writes every
 * supplied envelope in a single flush, so the whole burst lands on the client's
 * reader thread before its connect coroutine can resume.
 */
private class BurstingSyncHost(private val frames: List<String>) : Closeable {
    private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    private val worker = thread(isDaemon = true) { serve() }

    val port: Int get() = server.localPort

    private fun serve() {
        val socket = runCatching { server.accept() }.getOrNull() ?: return
        socket.use {
            val input = socket.getInputStream()
            val request = StringBuilder()
            while (!request.endsWith("\r\n\r\n")) {
                val next = input.read()
                if (next == -1) return
                request.append(next.toChar())
            }
            val key = request.lines()
                .firstOrNull { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
                ?.substringAfter(':')?.trim()
                ?: return
            val accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1")
                    .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
            )
            val output = socket.getOutputStream()
            output.write(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Accept: $accept\r\n\r\n"
                    ).toByteArray()
            )
            val burst = frames.fold(ByteArray(0)) { acc, frame -> acc + textFrame(frame) }
            output.write(burst)
            output.flush()
            // Hold the connection open; the client drives the teardown.
            runCatching { while (input.read() != -1) Unit }
        }
    }

    private fun textFrame(text: String): ByteArray {
        val payload = text.toByteArray(Charsets.UTF_8)
        val header = when {
            payload.size < 126 -> byteArrayOf(0x81.toByte(), payload.size.toByte())
            payload.size < 65_536 -> byteArrayOf(
                0x81.toByte(),
                126.toByte(),
                (payload.size shr 8).toByte(),
                payload.size.toByte(),
            )
            else -> error("The test host only frames payloads below 64 KiB")
        }
        return header + payload
    }

    override fun close() {
        runCatching { server.close() }
        worker.interrupt()
    }
}
