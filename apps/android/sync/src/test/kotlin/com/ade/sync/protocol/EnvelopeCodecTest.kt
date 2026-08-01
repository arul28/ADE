package com.ade.sync.protocol

import com.ade.sync.model.EnvelopeChunk
import com.ade.sync.model.ChatSubscribe
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class EnvelopeCodecTest {
    private val codec = EnvelopeCodec(compressionThresholdBytes = 1)

    @Test
    fun `personal chat subscriptions carry an explicit projectless scope`() {
        val payload = codec.json.encodeToJsonElement(
            ChatSubscribe.serializer(),
            ChatSubscribe("personal-1", sinceSeq = 7, chatScope = "personal"),
        ).jsonObject

        assertEquals("personal", payload["chatScope"]?.jsonPrimitive?.content)
    }

    @Test
    fun `round trips captured hello-shaped frame with deflate`() {
        val payload = buildJsonObject {
            put("peer", buildJsonObject {
                put("deviceId", "android-test")
                put("platform", "android")
                put("deviceType", "phone")
            })
        }
        val decoded = codec.decode(codec.encode("hello", payload, "hello-1", compression = "deflate"))
        assertEquals("hello", decoded.type)
        assertEquals("android", decoded.payload.jsonObject["peer"]!!.jsonObject["platform"]!!.jsonPrimitive.content)
    }

    @Test
    fun `decodes a host generated node zlib frame`() {
        // Generated with apps/ade-cli's Node zlib contract (`deflateSync`),
        // rather than this codec, so this catches cross-runtime drift.
        val frame = """{"version":1,"type":"hello","requestId":"host-vector","compression":"deflate","payloadEncoding":"base64","payload":"eJyrVipITS1SsqpWSkkty0xO9UxRslJKzEspys9M0S1JLS5R0lEqyEksScsvykXIKOlAlYdUFqQqWSkVZOTnpSrV1gIAJg0bFg==","uncompressedBytes":78}"""

        val decoded = codec.decode(frame)

        assertEquals("host-vector", decoded.requestId)
        assertEquals("phone", decoded.payload.jsonObject["peer"]!!.jsonObject["deviceType"]!!.jsonPrimitive.content)
    }

    @Test
    fun `outgoing frames honor the negotiated compression threshold`() {
        val payload = buildJsonObject { put("text", "small") }

        val encoded = codec.encodeFrames(
            type = "chat_event",
            payload = payload,
            compression = "deflate",
            compressionThresholdBytes = 4_096,
        ).single()

        assertEquals("none", codec.json.decodeFromString(com.ade.sync.model.SyncEnvelope.serializer(), encoded).compression)
    }

    @Test
    fun `rejects unsupported protocol versions`() {
        assertFailsWith<ProtocolVersionMismatch> {
            codec.decode("""{"version":2,"type":"future","compression":"none","payloadEncoding":"json","payload":{}}""")
        }
    }

    @Test
    fun `bounded chunk assembler accepts out of order parts and rejects malformed base64`() {
        val assembler = EnvelopeChunkAssembler()
        val source = """{"version":1,"type":"roster_snapshot"}""".toByteArray()
        val split = source.size / 2
        val first = Base64.getEncoder().encodeToString(source.copyOfRange(0, split))
        val second = Base64.getEncoder().encodeToString(source.copyOfRange(split, source.size))
        assertNull(assembler.add(EnvelopeChunk("chunk", 1, 2, second)))
        assertEquals(source.toString(Charsets.UTF_8), assembler.add(EnvelopeChunk("chunk", 0, 2, first)))
        assertNull(assembler.add(EnvelopeChunk("bad", 0, 1, "%%%")))
    }

    @Test
    fun `oversized envelopes split into reassemblable chunks`() {
        val frames = codec.encodeFrames(
            type = "chat_event",
            payload = buildJsonObject { put("text", "x".repeat(200_000)) },
            maximumFrameBytes = 48 * 1024,
        )
        assert(frames.size > 1)
        val assembler = EnvelopeChunkAssembler()
        var assembled: String? = null
        frames.forEach { frame ->
            val envelope = codec.decode(frame)
            val chunk = codec.json.decodeFromJsonElement(EnvelopeChunk.serializer(), envelope.payload)
            assembled = assembler.add(chunk) ?: assembled
        }
        assertNotNull(assembled)
        assertEquals("chat_event", codec.decode(assembled).type)
    }
}
