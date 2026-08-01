package com.ade.sync.protocol

import com.ade.sync.model.EnvelopeChunk
import com.ade.sync.model.SYNC_PROTOCOL_MIN_SUPPORTED
import com.ade.sync.model.SYNC_PROTOCOL_VERSION
import com.ade.sync.model.SyncEnvelope
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.LinkedHashMap
import java.util.UUID
import java.util.zip.DeflaterOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import java.util.zip.InflaterInputStream
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

class ProtocolVersionMismatch(val received: Int) : IllegalArgumentException(
    "Sync protocol version $received is incompatible with this client " +
        "(supported: $SYNC_PROTOCOL_MIN_SUPPORTED-$SYNC_PROTOCOL_VERSION)",
)

class EnvelopeCodec(
    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        isLenient = false
    },
    private val maximumUncompressedBytes: Int = 25 * 1024 * 1024,
    private val compressionThresholdBytes: Int = 4 * 1024,
) {
    fun encode(
        type: String,
        payload: JsonElement = JsonNull,
        requestId: String? = null,
        projectId: String? = null,
        compression: String = "none",
        thresholdBytes: Int = compressionThresholdBytes,
    ): String {
        val payloadJson = json.encodeToString(JsonElement.serializer(), payload)
        val payloadBytes = payloadJson.toByteArray(Charsets.UTF_8)
        val shouldCompress = compression in setOf("gzip", "deflate") &&
            payloadBytes.size >= thresholdBytes.coerceAtLeast(0)
        val envelope = if (shouldCompress) {
            val compressed = when (compression) {
                "gzip" -> gzip(payloadBytes)
                else -> deflate(payloadBytes)
            }
            SyncEnvelope(
                type = type,
                requestId = requestId?.trim()?.ifEmpty { null },
                projectId = projectId?.trim()?.ifEmpty { null },
                compression = compression,
                payloadEncoding = "base64",
                payload = JsonPrimitive(Base64.getEncoder().encodeToString(compressed)),
                uncompressedBytes = payloadBytes.size,
            )
        } else {
            SyncEnvelope(
                type = type,
                requestId = requestId?.trim()?.ifEmpty { null },
                projectId = projectId?.trim()?.ifEmpty { null },
                payload = payload,
            )
        }
        return json.encodeToString(SyncEnvelope.serializer(), envelope)
    }

    fun decode(text: String): SyncEnvelope {
        val raw = json.decodeFromString(SyncEnvelope.serializer(), text)
        if (raw.version !in SYNC_PROTOCOL_MIN_SUPPORTED..SYNC_PROTOCOL_VERSION) {
            throw ProtocolVersionMismatch(raw.version)
        }
        if (raw.compression == "none") {
            require(raw.payloadEncoding == "json") { "Uncompressed sync payload must use json encoding" }
            return raw
        }
        require(raw.compression == "gzip" || raw.compression == "deflate") {
            "Unsupported sync compression ${raw.compression}"
        }
        require(raw.payloadEncoding == "base64") { "Compressed sync payload must use base64 encoding" }
        val encoded = (raw.payload as? JsonPrimitive)?.content
            ?: throw IllegalArgumentException("Compressed payload is not a base64 string")
        val compressed = try {
            Base64.getDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Compressed payload is not strict base64")
        }
        val bytes = when (raw.compression) {
            "gzip" -> gunzip(compressed)
            else -> inflate(compressed)
        }
        require(bytes.size <= maximumUncompressedBytes) { "Decoded sync envelope is too large" }
        raw.uncompressedBytes?.let { require(it == bytes.size) { "Sync payload size does not match its declaration" } }
        val decodedPayload = json.parseToJsonElement(bytes.toString(Charsets.UTF_8))
        return raw.copy(payload = decodedPayload)
    }

    fun encodeFrames(
        type: String,
        payload: JsonElement,
        requestId: String? = null,
        projectId: String? = null,
        compression: String = "none",
        maximumFrameBytes: Int? = null,
        compressionThresholdBytes: Int = this.compressionThresholdBytes,
    ): List<String> {
        val encoded = encode(type, payload, requestId, projectId, compression, compressionThresholdBytes)
        if (maximumFrameBytes == null || encoded.toByteArray().size <= maximumFrameBytes) return listOf(encoded)
        val raw = encoded.toByteArray(Charsets.UTF_8)
        val partBytes = maxOf(16 * 1024, ((maximumFrameBytes - 1024) * 3) / 4)
        val total = (raw.size + partBytes - 1) / partBytes
        val chunkId = UUID.randomUUID().toString()
        return (0 until total).map { index ->
            val start = index * partBytes
            val end = minOf(raw.size, start + partBytes)
            val chunk = EnvelopeChunk(
                chunkId = chunkId,
                index = index,
                total = total,
                part = Base64.getEncoder().encodeToString(raw.copyOfRange(start, end)),
            )
            encode(
                type = "envelope_chunk",
                payload = json.encodeToJsonElement(EnvelopeChunk.serializer(), chunk),
                requestId = requestId,
            )
        }
    }

    private fun gzip(bytes: ByteArray): ByteArray = ByteArrayOutputStream().use { output ->
        GZIPOutputStream(output).use { it.write(bytes) }
        output.toByteArray()
    }

    private fun deflate(bytes: ByteArray): ByteArray = ByteArrayOutputStream().use { output ->
        DeflaterOutputStream(output).use { it.write(bytes) }
        output.toByteArray()
    }

    private fun gunzip(bytes: ByteArray): ByteArray = boundedRead(GZIPInputStream(ByteArrayInputStream(bytes)))
    private fun inflate(bytes: ByteArray): ByteArray = boundedRead(InflaterInputStream(ByteArrayInputStream(bytes)))

    private fun boundedRead(input: java.io.InputStream): ByteArray = input.use {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val count = it.read(buffer)
            if (count < 0) break
            require(output.size() + count <= maximumUncompressedBytes) { "Decoded sync envelope is too large" }
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    }
}

class EnvelopeChunkAssembler(
    private val maximumConcurrentChunks: Int = 8,
    private val maximumTotalParts: Int = 512,
    private val maximumEnvelopeBytes: Int = 32 * 1024 * 1024,
    private val maximumBufferedBytes: Int = 32 * 1024 * 1024,
    private val timeoutMillis: Long = 30_000,
    private val clockMillis: () -> Long = System::currentTimeMillis,
) {
    private data class Buffer(
        val total: Int,
        val parts: MutableMap<Int, ByteArray> = mutableMapOf(),
        val createdAt: Long,
    )

    private val buffers = LinkedHashMap<String, Buffer>()

    @Synchronized
    fun add(chunk: EnvelopeChunk): String? {
        pruneExpired()
        if (chunk.chunkId.toByteArray().size > 128 || chunk.total !in 1..maximumTotalParts || chunk.index !in 0 until chunk.total) {
            buffers.remove(chunk.chunkId)
            return null
        }
        val decoded = try {
            if (chunk.part.length % 4 != 0 || !STRICT_BASE64.matches(chunk.part)) return null
            Base64.getDecoder().decode(chunk.part)
        } catch (_: IllegalArgumentException) {
            buffers.remove(chunk.chunkId)
            return null
        }
        while (chunk.chunkId !in buffers && buffers.size >= maximumConcurrentChunks) {
            buffers.remove(buffers.keys.first())
        }
        val buffer = buffers.getOrPut(chunk.chunkId) { Buffer(chunk.total, createdAt = clockMillis()) }
        if (buffer.total != chunk.total) {
            buffers.remove(chunk.chunkId)
            return null
        }
        buffer.parts[chunk.index] = decoded
        val bufferBytes = buffer.parts.values.sumOf(ByteArray::size)
        val allBytes = buffers.values.sumOf { it.parts.values.sumOf(ByteArray::size) }
        if (bufferBytes > maximumEnvelopeBytes || allBytes > maximumBufferedBytes) {
            buffers.remove(chunk.chunkId)
            return null
        }
        if (buffer.parts.size != buffer.total) return null
        val output = ByteArrayOutputStream(bufferBytes)
        for (index in 0 until buffer.total) output.write(buffer.parts[index] ?: return null)
        buffers.remove(chunk.chunkId)
        return output.toByteArray().toString(Charsets.UTF_8)
    }

    @Synchronized
    fun clear() = buffers.clear()

    private fun pruneExpired() {
        val cutoff = clockMillis() - timeoutMillis
        buffers.entries.removeIf { it.value.createdAt <= cutoff }
    }

    companion object {
        private val STRICT_BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")
    }
}
